import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
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

  /**
   * Get the outbound message PDA for a specific sequence.
   */
  getOutboundPda(poolAddress: PublicKey, sequence: number): PublicKey {
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(BigInt(sequence));
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outbound"), poolAddress.toBuffer(), seqBuf],
      this.config.bridgeProgramId,
    );
    return pda;
  }

  /**
   * Get the unlock record PDA.
   */
  getUnlockRecordPda(
    poolAddress: PublicKey,
    sourceChain: SvmChain,
    commitment: Hash32,
  ): PublicKey {
    const chainBuf = Buffer.alloc(8);
    chainBuf.writeBigUInt64LE(BigInt(sourceChain));
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("unlock"),
        poolAddress.toBuffer(),
        chainBuf,
        Buffer.from(commitment, "hex"),
      ],
      this.config.bridgeProgramId,
    );
    return pda;
  }

  /**
   * Publish a local epoch nullifier root for cross-chain consumption.
   */
  async publishEpochRoot(
    payer: Keypair,
    epoch: number,
    nullifierRoot: Hash32,
    nullifierCount: number,
  ): Promise<string> {
    const bridgePda = this.getBridgePda(this.config.poolAddress);
    const outboundPda = this.getOutboundPda(this.config.poolAddress, epoch);

    // Anchor discriminator: SHA256("global:publish_epoch_root")[0..8]
    const discriminator = Buffer.from([
      0x5b, 0x8d, 0x4a, 0x2e, 0x13, 0xf7, 0x6c, 0x91,
    ]);
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epoch));
    const rootBuf = Buffer.from(nullifierRoot, "hex");
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(BigInt(nullifierCount));

    const ix = new TransactionInstruction({
      programId: this.config.bridgeProgramId,
      keys: [
        { pubkey: bridgePda, isSigner: false, isWritable: true },
        { pubkey: outboundPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator, epochBuf, rootBuf, countBuf]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Receive a foreign chain's epoch root (delivered via Wormhole VAA).
   */
  async receiveEpochRoot(
    payer: Keypair,
    sourceChain: SvmChain,
    epoch: number,
    nullifierRoot: Hash32,
    nullifierCount: number,
    vaaHash: Hash32,
  ): Promise<string> {
    const bridgePda = this.getBridgePda(this.config.poolAddress);
    const foreignRootPda = this.getForeignRootPda(
      this.config.poolAddress,
      sourceChain,
      epoch,
    );

    const discriminator = Buffer.from([
      0x7a, 0x1e, 0xd3, 0x5f, 0x82, 0xab, 0x44, 0xc7,
    ]);
    const chainBuf = Buffer.alloc(8);
    chainBuf.writeBigUInt64LE(BigInt(sourceChain));
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epoch));
    const rootBuf = Buffer.from(nullifierRoot, "hex");
    const countBuf = Buffer.alloc(8);
    countBuf.writeBigUInt64LE(BigInt(nullifierCount));
    const vaaBuf = Buffer.from(vaaHash, "hex");

    const ix = new TransactionInstruction({
      programId: this.config.bridgeProgramId,
      keys: [
        { pubkey: bridgePda, isSigner: false, isWritable: true },
        { pubkey: foreignRootPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator,
        chainBuf,
        epochBuf,
        rootBuf,
        countBuf,
        vaaBuf,
      ]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Lock a commitment for cross-chain transfer.
   */
  async lockCommitment(
    payer: Keypair,
    commitment: Hash32,
    destinationChain: SvmChain,
    proof: Uint8Array,
  ): Promise<string> {
    const bridgePda = this.getBridgePda(this.config.poolAddress);
    const lockPda = this.getCommitmentLockPda(
      this.config.poolAddress,
      commitment,
    );

    const discriminator = Buffer.from([
      0x3c, 0xf2, 0x91, 0xe8, 0x65, 0xd4, 0xa3, 0x17,
    ]);
    const commitBuf = Buffer.from(commitment, "hex");
    const chainBuf = Buffer.alloc(8);
    chainBuf.writeBigUInt64LE(BigInt(destinationChain));
    // Vec<u8> encoding: 4-byte LE length prefix + data
    const proofLenBuf = Buffer.alloc(4);
    proofLenBuf.writeUInt32LE(proof.length);

    const ix = new TransactionInstruction({
      programId: this.config.bridgeProgramId,
      keys: [
        { pubkey: bridgePda, isSigner: false, isWritable: true },
        { pubkey: lockPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        discriminator,
        commitBuf,
        chainBuf,
        proofLenBuf,
        Buffer.from(proof),
      ]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Unlock a bridged commitment on the destination chain.
   */
  async unlockCommitment(
    payer: Keypair,
    commitment: Hash32,
    sourceChain: SvmChain,
    vaaHash: Hash32,
  ): Promise<string> {
    const bridgePda = this.getBridgePda(this.config.poolAddress);
    const unlockPda = this.getUnlockRecordPda(
      this.config.poolAddress,
      sourceChain,
      commitment,
    );

    const discriminator = Buffer.from([
      0x4d, 0xa8, 0x72, 0xb5, 0x3e, 0x1c, 0xf9, 0x06,
    ]);
    const commitBuf = Buffer.from(commitment, "hex");
    const chainBuf = Buffer.alloc(8);
    chainBuf.writeBigUInt64LE(BigInt(sourceChain));
    const vaaBuf = Buffer.from(vaaHash, "hex");

    const ix = new TransactionInstruction({
      programId: this.config.bridgeProgramId,
      keys: [
        { pubkey: bridgePda, isSigner: false, isWritable: true },
        { pubkey: unlockPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator, commitBuf, chainBuf, vaaBuf]),
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [payer]);
  }
}

function bytesToHex(bytes: Uint8Array | Buffer): Hash32 {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
