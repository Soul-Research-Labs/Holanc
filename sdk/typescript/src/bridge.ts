import { Connection, PublicKey } from "@solana/web3.js";
import { Hash32, EpochRecord } from "./types";

/**
 * Cross-chain bridge client for the Holanc privacy protocol.
 *
 * Manages cross-chain epoch root synchronization, commitment locking/unlocking,
 * and foreign nullifier verification.
 */

/** Supported SVM chains. */
export enum SvmChain {
  Solana = 1,
  Eclipse = 2,
  Sonic = 3,
}

/** Bridge configuration for a specific pool. */
export interface BridgeConfig {
  bridgeProgramId: PublicKey;
  poolAddress: PublicKey;
  localChainId: SvmChain;
  localAppId: number;
}

/** An outbound epoch root message waiting for Wormhole relay. */
export interface OutboundEpochRoot {
  sourceChain: SvmChain;
  epoch: number;
  nullifierRoot: Hash32;
  nullifierCount: number;
  sequence: number;
  timestamp: number;
}

/** A foreign epoch root received from another chain. */
export interface ForeignEpochRoot {
  sourceChain: SvmChain;
  epoch: number;
  nullifierRoot: Hash32;
  nullifierCount: number;
  vaaHash: Hash32;
  receivedAt: number;
}

/** Commitment lock record. */
export interface CommitmentLock {
  commitment: Hash32;
  sourceChain: SvmChain;
  destinationChain: SvmChain;
  lockedAt: number;
  isUnlocked: boolean;
}

const BRIDGE_PROGRAM_ID = new PublicKey(
  "H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K",
);

/**
 * HolancBridge — client for cross-chain privacy operations.
 */
export class HolancBridge {
  private connection: Connection;
  private config: BridgeConfig;

  constructor(connection: Connection, config: Partial<BridgeConfig> = {}) {
    this.connection = connection;
    this.config = {
      bridgeProgramId: config.bridgeProgramId ?? BRIDGE_PROGRAM_ID,
      poolAddress: config.poolAddress ?? PublicKey.default,
      localChainId: config.localChainId ?? SvmChain.Solana,
      localAppId: config.localAppId ?? 0,
    };
  }

  /**
   * Get the bridge config PDA address for a pool.
   */
  getBridgePda(poolAddress: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge"), poolAddress.toBuffer()],
      this.config.bridgeProgramId,
    );
    return pda;
  }

  /**
   * Get the foreign root PDA for a specific source chain and epoch.
   */
  getForeignRootPda(
    poolAddress: PublicKey,
    sourceChain: SvmChain,
    epoch: number,
  ): PublicKey {
    const chainBuf = Buffer.alloc(8);
    chainBuf.writeBigUInt64LE(BigInt(sourceChain));
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epoch));

    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("foreign_root"), poolAddress.toBuffer(), chainBuf, epochBuf],
      this.config.bridgeProgramId,
    );
    return pda;
  }

  /**
   * Fetch a foreign epoch root from on-chain state.
   */
  async getForeignRoot(
    sourceChain: SvmChain,
    epoch: number,
  ): Promise<ForeignEpochRoot | null> {
    const pda = this.getForeignRootPda(
      this.config.poolAddress,
      sourceChain,
      epoch,
    );
    const info = await this.connection.getAccountInfo(pda);
    if (!info) return null;

    // Deserialize (Anchor layout: 8-byte discriminator + struct)
    const data = info.data.slice(8);
    return {
      sourceChain,
      epoch,
      nullifierRoot: bytesToHex(data.slice(40, 72)),
      nullifierCount: Number(data.readBigUInt64LE(72)),
      vaaHash: bytesToHex(data.slice(80, 112)),
      receivedAt: Number(data.readBigInt64LE(112)),
    };
  }

  /**
   * Check if a nullifier exists in any foreign chain's epoch roots.
   *
   * This is a client-side convenience; the on-chain verification uses
   * a Merkle proof via verify_foreign_nullifier.
   */
  async isNullifierOnForeignChain(
    nullifier: Hash32,
    sourceChain: SvmChain,
    epochs: number[],
  ): Promise<{ found: boolean; epoch?: number }> {
    for (const epoch of epochs) {
      const root = await this.getForeignRoot(sourceChain, epoch);
      if (root) {
        // In production, check Merkle proof against the root
        // For now, this signals the root exists and could contain the nullifier
        return { found: false, epoch };
      }
    }
    return { found: false };
  }

  /**
   * Get the commitment lock PDA for a specific commitment.
   */
  getCommitmentLockPda(poolAddress: PublicKey, commitment: Hash32): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lock"),
        poolAddress.toBuffer(),
        Buffer.from(commitment, "hex"),
      ],
      this.config.bridgeProgramId,
    );
    return pda;
  }
}

function bytesToHex(bytes: Uint8Array | Buffer): Hash32 {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
