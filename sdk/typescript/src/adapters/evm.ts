/**
 * EvmAdapter — ChainAdapter implementation for EVM chains using ethers.js v6.
 *
 * Interfaces with deployed HolancPool, HolancVerifier, and HolancNullifier
 * Solidity contracts on Ethereum mainnet (or any EVM-compatible chain).
 */

import type { ContractTransaction, Signer, providers } from "ethers";
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

// ---------------------------------------------------------------------------
// Minimal ABI fragments for contract interaction
// ---------------------------------------------------------------------------

const POOL_ABI = [
  // Deposit
  "function deposit(uint256 amount, bytes32 commitment, bytes calldata encryptedNote) external",
  // Transfer
  "function transfer(bytes32 merkleRoot, bytes32[2] calldata nullifiers, bytes32[2] calldata outputCommitments, uint256 fee, bytes[] calldata encryptedNotes, uint256[2] calldata proofA, uint256[2][2] calldata proofB, uint256[2] calldata proofC) external",
  // Withdraw
  "function withdraw(bytes32 merkleRoot, bytes32[2] calldata nullifiers, bytes32[2] calldata outputCommitments, uint256 exitAmount, uint256 fee, address recipient, bytes[] calldata encryptedNotes, uint256[2] calldata proofA, uint256[2][2] calldata proofB, uint256[2] calldata proofC) external",
  // State
  "function currentRoot() external view returns (bytes32)",
  "function nextLeafIndex() external view returns (uint64)",
  "function totalDeposited() external view returns (uint256)",
  "function isPaused() external view returns (bool)",
  "function epoch() external view returns (uint64)",
  "function token() external view returns (address)",
  // Events
  "event DepositEvent(uint64 indexed leafIndex, bytes32 commitment, uint256 amount, bytes encryptedNote)",
  "event NewCommitment(uint64 indexed leafIndex, bytes32 commitment, bytes encryptedNote)",
  "event TransferEvent(bytes32[2] nullifiers, bytes32[2] outputCommitments, uint256 fee)",
  "event WithdrawEvent(bytes32[2] nullifiers, uint256 exitAmount, address indexed recipient, uint256 fee)",
];

const NULLIFIER_ABI = [
  "function isNullifierSpent(uint64 pageIndex, bytes32 nullifier) external view returns (bool)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ---------------------------------------------------------------------------
// Type helpers (ethers is optional)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContract = any;

type EthersNamespace = typeof import("ethers")["ethers"];

async function loadEthers(): Promise<EthersNamespace> {
  try {
    const mod = await import("ethers");
    return mod.ethers;
  } catch {
    throw new Error(
      "ethers.js is required for EvmAdapter. Install it: npm install ethers@6",
    );
  }
}

function requireProvider(signer: Signer): providers.Provider {
  if (!signer.provider) {
    throw new Error("EvmAdapter signer must be connected to a provider");
  }
  return signer.provider;
}

// ---------------------------------------------------------------------------
// Proof formatting
// ---------------------------------------------------------------------------

/**
 * Convert a snarkjs Groth16 proof to the [uint256[2], uint256[2][2], uint256[2]] format
 * expected by the Solidity verifier.
 */
function formatProofForEvm(proof: {
  piA: [string, string];
  piB: [[string, string], [string, string]];
  piC: [string, string];
}): {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
} {
  return {
    a: [BigInt(proof.piA[0]), BigInt(proof.piA[1])],
    // Note: snarkjs uses [x_im, x_re] order; EVM precompile expects coordinates
    // in the same BN254 convention — (x0, x1) where x = x0 + i·x1.
    b: [
      [BigInt(proof.piB[0][0]), BigInt(proof.piB[0][1])],
      [BigInt(proof.piB[1][0]), BigInt(proof.piB[1][1])],
    ],
    c: [BigInt(proof.piC[0]), BigInt(proof.piC[1])],
  };
}

// ---------------------------------------------------------------------------
// EvmAdapter
// ---------------------------------------------------------------------------

export interface EvmAdapterConfig extends AdapterConfig {
  /** ethers.js Signer (e.g. wallet connected to MetaMask, or a local private key). */
  signer: Signer;
  /** Optional pre-approved allowance to skip ERC-20 approve calls. */
  skipApproval?: boolean;
}

export class EvmAdapter implements ChainAdapter {
  readonly chainName = "evm";

  private config: EvmAdapterConfig;

  private constructor(config: EvmAdapterConfig) {
    this.config = config;
  }

  /** Create an EvmAdapter instance. */
  static async create(config: EvmAdapterConfig): Promise<EvmAdapter> {
    return new EvmAdapter(config);
  }

  // -------------------------------------------------------------------------
  // Pool operations
  // -------------------------------------------------------------------------

  async deposit(params: DepositParams): Promise<DepositResult> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      this.config.signer,
    ) as AnyContract;

    // Approve ERC-20 spend if necessary
    if (!this.config.skipApproval) {
      await this._ensureApproval(params.tokenAddress, params.amount);
    }

    const commitmentBytes = this._hexToBytes32(params.commitment);
    const tx = (await pool.deposit(
      params.amount,
      commitmentBytes,
      params.encryptedNote,
    )) as ContractTransaction;
    const receipt = await tx.wait();
    if (!receipt) throw new Error("Transaction receipt not found");

    // Parse DepositEvent to get leaf index
    const poolIface = new ethers.utils.Interface(POOL_ABI);
    let leafIndex = 0;
    for (const log of receipt.logs) {
      try {
        const parsed = poolIface.parseLog(log as { topics: string[]; data: string });
        if (parsed?.name === "DepositEvent") {
          leafIndex = Number(parsed.args[0]);
          break;
        }
      } catch {
        // not our event
      }
    }

    return {
      commitment: params.commitment,
      leafIndex,
      txSignature: tx.hash,
    };
  }

  async transfer(params: TransferParams): Promise<TransferResult> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      this.config.signer,
    ) as AnyContract;

    const { a, b, c } = formatProofForEvm(params.proof);

    const tx = (await pool.transfer(
      this._hexToBytes32(params.merkleRoot),
      params.nullifiers.map((n) => this._hexToBytes32(n)),
      params.outputCommitments.map((cm) => this._hexToBytes32(cm)),
      params.fee,
      params.encryptedNotes,
      a,
      b,
      c,
    )) as ContractTransaction;
    await tx.wait();

    return {
      nullifiers: params.nullifiers as [string, string],
      outputCommitments: params.outputCommitments as [string, string],
      txSignature: tx.hash,
    };
  }

  async withdraw(params: WithdrawParams): Promise<WithdrawResult> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      this.config.signer,
    ) as AnyContract;

    const { a, b, c } = formatProofForEvm(params.proof);

    const tx = (await pool.withdraw(
      this._hexToBytes32(params.merkleRoot),
      params.nullifiers.map((n) => this._hexToBytes32(n)),
      params.outputCommitments.map((cm) => this._hexToBytes32(cm)),
      params.exitAmount,
      params.fee,
      params.recipientAddress,
      params.encryptedNotes,
      a,
      b,
      c,
    )) as ContractTransaction;
    await tx.wait();

    return {
      nullifiers: params.nullifiers as [string, string],
      exitAmount: params.exitAmount,
      txSignature: tx.hash,
    };
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  async getPoolStatus(): Promise<AdapterPoolStatus> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      requireProvider(this.config.signer),
    ) as AnyContract;

    const [root, nextLeafIndex, totalDeposited, isPaused, epoch, tokenAddr] =
      await Promise.all([
        pool.currentRoot(),
        pool.nextLeafIndex(),
        pool.totalDeposited(),
        pool.isPaused(),
        pool.epoch(),
        pool.token(),
      ]);

    return {
      poolAddress: this.config.poolAddress,
      tokenAddress: tokenAddr as string,
      totalDeposited: BigInt(totalDeposited),
      nextLeafIndex: Number(nextLeafIndex),
      currentRoot: root as string,
      isPaused: isPaused as boolean,
      epoch: Number(epoch),
    };
  }

  async isNullifierSpent(nullifier: string): Promise<boolean> {
    if (!this.config.nullifierAddress) {
      throw new Error("nullifierAddress not configured");
    }
    const ethers = await loadEthers();
    const registry = new ethers.Contract(
      this.config.nullifierAddress,
      NULLIFIER_ABI,
      requireProvider(this.config.signer),
    ) as AnyContract;

    // Page index 0 — production code should derive the correct page from the nullifier.
    return registry.isNullifierSpent(0, this._hexToBytes32(nullifier));
  }

  async getMerkleRoot(): Promise<string> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      requireProvider(this.config.signer),
    ) as AnyContract;
    return pool.currentRoot();
  }

  // -------------------------------------------------------------------------
  // Event scanning
  // -------------------------------------------------------------------------

  async getCommitments(
    fromBlock: number,
    toBlock: number,
  ): Promise<CommitmentEvent[]> {
    const ethers = await loadEthers();
    const pool = new ethers.Contract(
      this.config.poolAddress,
      POOL_ABI,
      requireProvider(this.config.signer),
    ) as AnyContract;

    const filter = pool.filters.NewCommitment();
    const logs = await pool.queryFilter(filter, fromBlock, toBlock);

    return logs.map(
      (log: {
        args: [bigint, string, string];
        transactionHash: string;
        blockNumber: number;
      }) => ({
        leafIndex: Number(log.args[0]),
        commitment: log.args[1],
        encryptedNote: Uint8Array.from(ethers.utils.arrayify(log.args[2])),
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _hexToBytes32(hex: string): string {
    // Normalize to 0x-prefixed 32-byte hex
    const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
    return clean.padEnd(66, "0"); // 0x + 64 hex chars
  }

  private async _ensureApproval(
    tokenAddress: string,
    amount: bigint,
  ): Promise<void> {
    const ethers = await loadEthers();
    const token = new ethers.Contract(
      tokenAddress,
      ERC20_ABI,
      this.config.signer,
    ) as AnyContract;

    const signerAddress = await this.config.signer.getAddress();
    const allowance: bigint = await token.allowance(
      signerAddress,
      this.config.poolAddress,
    );

    if (allowance < amount) {
      const tx = (await token.approve(
        this.config.poolAddress,
        amount,
      )) as ContractTransaction;
      await tx.wait();
    }
  }
}
