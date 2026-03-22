/**
 * SolanaAdapter — ChainAdapter implementation wrapping the existing HolancClient.
 *
 * Bridges the generic ChainAdapter interface to the Solana-specific HolancClient,
 * HolancWallet, and @solana/web3.js infrastructure.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ChainAdapter,
  AdapterConfig,
  DepositParams,
  TransferParams,
  WithdrawParams,
  AdapterPoolStatus,
  CommitmentEvent,
} from "./types";
import { DepositResult, TransferResult, WithdrawResult } from "../types";
import { HolancClient } from "../client";
import { HolancWallet } from "../wallet";
import { RpcEndpointConfig, FailoverConfig } from "../rpc";

export interface SolanaAdapterConfig extends AdapterConfig {
  /** Solana transaction fee payer keypair. */
  payer: Keypair;
  /** Optional existing wallet; a random one will be created if omitted. */
  wallet?: HolancWallet;
  /** Optional indexer HTTP base URL used for commitment lookups. */
  indexerUrl?: string;
  /** Token mint address (Solana SPL token). */
  tokenMint: string;
  /** Optional secondary RPC endpoints for failover. */
  failoverEndpoints?: (string | RpcEndpointConfig)[];
  /** Failover behavior options. */
  failoverConfig?: FailoverConfig;
  /** Verification key PDA (must match the deployed verifier program). */
  verificationKey?: string;
  /** Nullifier manager PDA. */
  nullifierManager?: string;
  /** Nullifier page PDA. */
  nullifierPage?: string;
  /** Fee collector token account address. */
  feeCollector?: string;
}

export class SolanaAdapter implements ChainAdapter {
  readonly chainName = "solana";

  private client: HolancClient;
  private config: SolanaAdapterConfig;
  private wallet: HolancWallet;

  private constructor(
    client: HolancClient,
    config: SolanaAdapterConfig,
    wallet: HolancWallet,
  ) {
    this.client = client;
    this.config = config;
    this.wallet = wallet;
  }

  /** Create a SolanaAdapter from configuration. */
  static async create(config: SolanaAdapterConfig): Promise<SolanaAdapter> {
    const wallet = config.wallet ?? (await HolancWallet.random());
    const client =
      config.failoverEndpoints && config.failoverEndpoints.length > 0
        ? await HolancClient.createWithFailover(
            [config.rpcUrl, ...config.failoverEndpoints],
            config.payer,
            config.failoverConfig,
            wallet,
          )
        : await HolancClient.create(config.rpcUrl, config.payer, wallet);

    return new SolanaAdapter(client, config, wallet);
  }

  // -------------------------------------------------------------------------
  // Pool operations
  // -------------------------------------------------------------------------

  async deposit(params: DepositParams): Promise<DepositResult> {
    const tokenMint = new PublicKey(
      params.tokenAddress || this.config.tokenMint,
    );
    return this.client.deposit(params.amount, tokenMint);
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    const tokenMint = new PublicKey(this.config.tokenMint);
    const feeCollector = this.config.feeCollector
      ? new PublicKey(this.config.feeCollector)
      : undefined;
    const verificationKey = this.config.verificationKey
      ? new PublicKey(this.config.verificationKey)
      : undefined;
    const nullifierManager = this.config.nullifierManager
      ? new PublicKey(this.config.nullifierManager)
      : undefined;
    const nullifierPage = this.config.nullifierPage
      ? new PublicKey(this.config.nullifierPage)
      : undefined;

    // Transfer on Solana uses destination owner hash derived from the first output commitment.
    // The recipient's owner hash is embedded in the outputCommitments[0].
    const recipientOwnerHash = params.outputCommitments[0];
    const amount = params.amount;

    if (amount < 0n) {
      throw new Error("transfer amount must be non-negative");
    }

    return this.client.transfer(
      recipientOwnerHash,
      amount,
      tokenMint,
      params.fee,
      feeCollector,
      verificationKey,
      nullifierManager,
      nullifierPage,
    );
  }

  async withdraw(params: WithdrawParams): Promise<WithdrawResult> {
    const tokenMint = new PublicKey(this.config.tokenMint);
    const recipient = new PublicKey(params.recipientAddress);
    const feeCollector = this.config.feeCollector
      ? new PublicKey(this.config.feeCollector)
      : undefined;
    const verificationKey = this.config.verificationKey
      ? new PublicKey(this.config.verificationKey)
      : undefined;
    const nullifierManager = this.config.nullifierManager
      ? new PublicKey(this.config.nullifierManager)
      : undefined;
    const nullifierPage = this.config.nullifierPage
      ? new PublicKey(this.config.nullifierPage)
      : undefined;

    return this.client.withdraw(
      params.exitAmount,
      tokenMint,
      recipient,
      params.fee,
      feeCollector,
      verificationKey,
      nullifierManager,
      nullifierPage,
    );
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  async getPoolStatus(): Promise<AdapterPoolStatus> {
    const status = await this.client.getPoolStatus(
      new PublicKey(this.config.tokenMint),
    );
    return {
      poolAddress: status.poolAddress,
      tokenAddress: status.tokenMint,
      totalDeposited: status.totalDeposited,
      nextLeafIndex: status.nextLeafIndex,
      currentRoot: status.currentRoot,
      isPaused: status.isPaused,
      epoch: status.epoch,
    };
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    void nullifier;
    throw new Error(
      "SolanaAdapter.isNullifierSpent is not implemented in HolancClient yet",
    );
  }

  async getMerkleRoot(): Promise<string> {
    const status = await this.client.getPoolStatus(
      new PublicKey(this.config.tokenMint),
    );
    return status.currentRoot;
  }

  // -------------------------------------------------------------------------
  // Event scanning
  // -------------------------------------------------------------------------

  async getCommitments(
    fromBlock: number,
    toBlock: number,
  ): Promise<CommitmentEvent[]> {
    const indexerUrl =
      this.config.indexerUrl ??
      process.env.INDEXER_URL ??
      process.env.NEXT_PUBLIC_INDEXER_URL;

    if (!indexerUrl) {
      throw new Error(
        "SolanaAdapter.getCommitments requires indexerUrl or INDEXER_URL",
      );
    }

    const url = new URL(`/notes?from=${fromBlock}&to=${toBlock}`, indexerUrl);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Indexer returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as {
      notes: Array<{
        commitment: string;
        leafIndex: number;
        encryptedNote: string;
        txSignature: string;
        slot: number;
      }>;
    };

    return body.notes.map((note) => ({
      leafIndex: note.leafIndex,
      commitment: note.commitment,
      encryptedNote: Uint8Array.from(Buffer.from(note.encryptedNote, "hex")),
      txHash: note.txSignature,
      blockNumber: note.slot,
    }));
  }

  /** Access the underlying HolancClient for Solana-specific operations. */
  get holancClient(): HolancClient {
    return this.client;
  }

  /** Access the underlying HolancWallet used by the adapter. */
  get holancWallet(): HolancWallet {
    return this.wallet;
  }
}
