/**
 * ChainAdapter — abstract interface for interacting with Holanc on any supported chain.
 *
 * Implementations:
 *   - SolanaAdapter (./solana.ts) — Anchor/web3.js for Solana/SVM chains
 *   - EvmAdapter    (./evm.ts)    — ethers.js v6 for EVM chains
 */

import {
  DepositResult,
  TransferResult,
  WithdrawResult,
  PoolStatus,
  Groth16Proof,
} from "../types";

/** Abstract deposit parameters. */
export interface DepositParams {
  amount: bigint;
  commitment: string; // 32-byte hex prefixed with 0x
  encryptedNote: Uint8Array;
  /** Token mint address (Solana) or ERC-20 contract address (EVM). */
  tokenAddress: string;
}

/** Abstract transfer parameters. */
export interface TransferParams {
  amount: bigint;
  merkleRoot: string;
  nullifiers: [string, string];
  outputCommitments: [string, string];
  fee: bigint;
  encryptedNotes: [Uint8Array, Uint8Array];
  proof: Groth16Proof;
}

/** Abstract withdraw parameters. */
export interface WithdrawParams {
  merkleRoot: string;
  nullifiers: [string, string];
  outputCommitments: [string, string];
  exitAmount: bigint;
  fee: bigint;
  recipientAddress: string;
  encryptedNotes: [Uint8Array, Uint8Array];
  proof: Groth16Proof;
}

/** Abstracted pool status (chain-agnostic). */
export interface AdapterPoolStatus {
  poolAddress: string;
  tokenAddress: string;
  totalDeposited: bigint;
  nextLeafIndex: number;
  currentRoot: string;
  isPaused: boolean;
  epoch: number;
}

/** Abstracted commitment event from indexer. */
export interface CommitmentEvent {
  leafIndex: number;
  commitment: string;
  encryptedNote: Uint8Array;
  txHash: string;
  blockNumber: number;
}

/** A chain-agnostic abstraction over the Holanc protocol. */
export interface ChainAdapter {
  /** Human-readable chain name (e.g. "solana", "ethereum"). */
  readonly chainName: string;

  // -------------------------------------------------------------------------
  // Pool operations
  // -------------------------------------------------------------------------

  deposit(params: DepositParams): Promise<DepositResult>;
  transfer(params: TransferParams): Promise<TransferResult>;
  withdraw(params: WithdrawParams): Promise<WithdrawResult>;

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  getPoolStatus(): Promise<AdapterPoolStatus>;
  isNullifierSpent(nullifier: string): Promise<boolean>;
  getMerkleRoot(): Promise<string>;

  // -------------------------------------------------------------------------
  // Event scanning
  // -------------------------------------------------------------------------

  /** Fetch commitment events from block range. */
  getCommitments(
    fromBlock: number,
    toBlock: number,
  ): Promise<CommitmentEvent[]>;
}

/** Factory function signature for building adapters from config. */
export type AdapterFactory = (config: AdapterConfig) => ChainAdapter;

/** Common configuration shared by all adapters. */
export interface AdapterConfig {
  /** RPC endpoint URL. */
  rpcUrl: string;
  /** Pool contract address (Anchor program ID on Solana, contract address on EVM). */
  poolAddress: string;
  /** Verifier contract address. */
  verifierAddress?: string;
  /** Nullifier contract address. */
  nullifierAddress?: string;
}
