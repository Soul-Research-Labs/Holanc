import { PublicKey } from "@solana/web3.js";

/** A 32-byte hash represented as a hex string. */
export type Hash32 = string;

/** A shielded note in the privacy pool. */
export interface Note {
  owner: Hash32;
  value: bigint;
  assetId: Hash32;
  blinding: Hash32;
  leafIndex?: number;
  spent: boolean;
}

/** Result of a deposit operation. */
export interface DepositResult {
  commitment: Hash32;
  leafIndex: number;
  txSignature: string;
}

/** Result of a private transfer. */
export interface TransferResult {
  nullifiers: [Hash32, Hash32];
  outputCommitments: [Hash32, Hash32];
  txSignature: string;
}

/** Result of a withdrawal. */
export interface WithdrawResult {
  nullifiers: [Hash32, Hash32];
  exitAmount: bigint;
  txSignature: string;
}

/** Groth16 proof ready for on-chain verification. */
export interface Groth16Proof {
  piA: [string, string];
  piB: [[string, string], [string, string]];
  piC: [string, string];
  publicSignals: string[];
}

/** Pool status information. */
export interface PoolStatus {
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  totalDeposited: bigint;
  nextLeafIndex: number;
  currentRoot: Hash32;
  isPaused: boolean;
  epoch: number;
}

/** Epoch record for cross-chain sync. */
export interface EpochRecord {
  epoch: number;
  nullifierRoot: Hash32;
  finalizedSlot: number;
  nullifierCount: number;
}

/** Circuit type identifiers for the prover. */
export enum CircuitType {
  Deposit = "deposit",
  Transfer = "transfer",
  Withdraw = "withdraw",
  TransferV2 = "transfer_v2",
  WithdrawV2 = "withdraw_v2",
  StealthTransfer = "stealth_transfer",
  WealthProof = "wealth_proof",
  Transfer4x4 = "transfer_4x4",
  Withdraw4x4 = "withdraw_4x4",
}

/** Result of a stealth transfer. */
export interface StealthTransferResult extends TransferResult {
  ephemeralPubkey: Hash32;
  stealthAddress: Hash32;
}

/** Parameters for a V2 nullifier transfer (with domain separation). */
export interface TransferV2Params {
  chainId: number;
  appId: number;
}

/** Wealth proof result. */
export interface WealthProofResult {
  proof: Groth16Proof;
  ownerCommitment: Hash32;
  threshold: bigint;
}
