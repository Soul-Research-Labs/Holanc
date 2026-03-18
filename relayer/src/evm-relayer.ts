import crypto from "crypto";

type EthersNamespace = typeof import("ethers")["ethers"];

async function loadEthers(): Promise<EthersNamespace> {
  const mod = await import("ethers");
  return mod.ethers;
}

/** Status of a queued EVM relay request. */
export interface EvmRelayStatus {
  id: string;
  state: "queued" | "pending" | "confirmed" | "failed";
  txHash?: string;
  error?: string;
  enqueuedAt: number;
  sentAt?: number;
}

/** Estimated EVM relay fee. */
export interface EvmFeeEstimate {
  gasPrice: string; // wei, as decimal string
  gasPriceGwei: string; // human-readable
  maxPriorityFeePerGas?: string;
  estimatedAt: number;
}

/**
 * EvmRelayer — receives pre-signed EVM transactions and broadcasts them with
 * jitter-based delay.  Ships each transaction individually (no batching) since
 * EVM transactions already carry their own nonce sequencing.
 *
 * Uses ethers.js v6 loaded via dynamic import so it remains an optional peer
 * dependency — the relayer process only requires ethers when ETH_RPC_URL /
 * ETH_RELAYER_PRIVATE_KEY are configured.
 */
export class EvmRelayer {
  private rpcUrl: string;
  private privateKey: string;
  private statuses = new Map<string, EvmRelayStatus>();

  constructor(rpcUrl: string, privateKey: string) {
    // Basic validation to fail fast at startup rather than at first request.
    if (!rpcUrl || !rpcUrl.startsWith("http")) {
      throw new Error(
        `EvmRelayer: invalid rpcUrl (must be http/https): ${rpcUrl}`,
      );
    }
    // Private key must be 32-byte hex (with or without 0x prefix).
    if (!privateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error(
        "EvmRelayer: invalid private key (expected 64 hex chars)",
      );
    }
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
  }

  /**
   * Enqueue a signed raw EVM transaction for broadcast.
   * The transaction is submitted after `delayMs` milliseconds (jitter).
   * Returns a tracking ID.
   */
  async enqueue(signedTx: string, delayMs: number): Promise<string> {
    const id = crypto.randomUUID();
    const entry: EvmRelayStatus = {
      id,
      state: "queued",
      enqueuedAt: Date.now(),
    };
    this.statuses.set(id, entry);

    // Fire-and-forget with delay.  The async error is caught internally and
    // recorded in the status map rather than rejected to the caller.
    setTimeout(() => {
      this._broadcast(id, signedTx).catch(() => {
        // errors already recorded in status entry — suppress unhandled rejection
      });
    }, Math.max(0, delayMs));

    return id;
  }

  /** Look up relay status by tracking ID. */
  status(id: string): EvmRelayStatus | undefined {
    return this.statuses.get(id);
  }

  /** Estimate current EVM gas price. */
  async estimateFee(): Promise<EvmFeeEstimate> {
    const ethers = await loadEthers();
    const provider = new ethers.providers.JsonRpcProvider(this.rpcUrl);
    const feeData = await provider.getFeeData();

    const gasPrice = feeData.gasPrice;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

    return {
      gasPrice: gasPrice?.toString() ?? "0",
      gasPriceGwei: gasPrice
        ? ethers.utils.formatUnits(gasPrice, "gwei")
        : "0",
      maxPriorityFeePerGas: maxPriorityFeePerGas
        ? maxPriorityFeePerGas.toString()
        : undefined,
      estimatedAt: Date.now(),
    };
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async _broadcast(id: string, signedTx: string): Promise<void> {
    const entry = this.statuses.get(id);
    if (!entry) return;

    entry.state = "pending";
    entry.sentAt = Date.now();

    try {
      const ethers = await loadEthers();
      const provider = new ethers.providers.JsonRpcProvider(this.rpcUrl);

      // Broadcast the pre-signed transaction.
      const txResponse = await provider.sendTransaction(signedTx);
      entry.txHash = txResponse.hash;

      // Wait for one confirmation.
      const receipt = await txResponse.wait(1);

      if (receipt && receipt.status === 1) {
        entry.state = "confirmed";
      } else {
        entry.state = "failed";
        entry.error = "Transaction reverted on-chain";
      }
    } catch (err: unknown) {
      entry.state = "failed";
      entry.error =
        err instanceof Error ? err.message : "Unknown broadcast error";
    }
  }
}
