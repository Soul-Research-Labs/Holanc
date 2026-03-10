import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { HolancWallet } from "./wallet";
import { HolancProver } from "./prover";
import {
  DepositResult,
  TransferResult,
  WithdrawResult,
  PoolStatus,
  Hash32,
} from "./types";

/** Program IDs — must match deployed Anchor programs. */
const POOL_PROGRAM_ID = new PublicKey(
  "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
);
const VERIFIER_PROGRAM_ID = new PublicKey(
  "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
);
const NULLIFIER_PROGRAM_ID = new PublicKey(
  "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);

/**
 * HolancClient — main entry point for interacting with the Holanc privacy protocol.
 *
 * Provides high-level methods for deposits, private transfers, and withdrawals.
 * Manages proof generation client-side and submits transactions on-chain.
 */
export class HolancClient {
  private connection: Connection;
  private wallet: HolancWallet;
  private prover: HolancProver;
  private payer: Keypair;

  private constructor(
    connection: Connection,
    payer: Keypair,
    wallet: HolancWallet,
  ) {
    this.connection = connection;
    this.payer = payer;
    this.wallet = wallet;
    this.prover = new HolancProver();
  }

  static async create(
    rpcUrl: string,
    payer: Keypair,
    wallet?: HolancWallet,
  ): Promise<HolancClient> {
    const connection = new Connection(rpcUrl, "confirmed");
    const w = wallet ?? (await HolancWallet.random());
    return new HolancClient(connection, payer, w);
  }

  /** Get the wallet's shielded balance. */
  balance(): bigint {
    return this.wallet.balance();
  }

  /** Get the wallet's transaction history. */
  history() {
    return this.wallet.history();
  }

  /** Get unspent notes. */
  unspentNotes() {
    return this.wallet.unspentNotes();
  }

  /**
   * Deposit tokens into the privacy pool.
   *
   * 1. Creates a note with the given amount.
   * 2. Computes the note commitment off-chain.
   * 3. Submits a deposit transaction (token transfer + commitment append).
   */
  async deposit(amount: bigint, tokenMint: PublicKey): Promise<DepositResult> {
    const note = await this.wallet.createDepositNote(amount);
    const commitment = await this.wallet.computeCommitment(note);

    // Build the deposit instruction (Anchor-compatible)
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      POOL_PROGRAM_ID,
    );

    // Request extra compute units for potential proof verification
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    // The deposit instruction data would be serialized via Anchor IDL.
    // For now, we prepare the structure that the Anchor program expects.
    const depositData = this.encodeDepositInstruction(
      amount,
      Buffer.from(commitment, "hex"),
      Buffer.alloc(0), // encrypted note (empty for self-deposit)
    );

    const depositIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolPda, isSigner: false, isWritable: true },
        // Additional accounts would be resolved from Anchor IDL
      ],
      data: depositData,
    });

    const tx = new Transaction().add(computeIx, depositIx);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.payer,
    ]);

    return {
      commitment,
      leafIndex: note.leafIndex ?? 0,
      txSignature: sig,
    };
  }

  /**
   * Execute a private transfer within the pool.
   *
   * 1. Select input notes covering the transfer amount.
   * 2. Generate a ZK proof (transfer circuit).
   * 3. Submit the transfer transaction with proof + nullifiers + new commitments.
   */
  async transfer(
    recipientOwner: Hash32,
    amount: bigint,
    fee: bigint = 0n,
  ): Promise<TransferResult> {
    const { inputNotes, outputNotes } = await this.wallet.prepareTransfer(
      recipientOwner,
      amount,
      fee,
    );

    // Generate proof
    const proof = await this.prover.proveTransfer({
      spendingKey: this.wallet.spendingKeyHex(),
      inputNotes,
      outputNotes,
      fee,
    });

    // Build and submit transaction
    const nullifiers: [Hash32, Hash32] = [
      proof.publicSignals[1],
      proof.publicSignals[2],
    ];
    const outputCommitments: [Hash32, Hash32] = [
      proof.publicSignals[3],
      proof.publicSignals[4],
    ];

    // Mark input notes as spent in local wallet
    this.wallet.markSpent(inputNotes);

    // Build and submit the transfer transaction on-chain
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool")],
      POOL_PROGRAM_ID,
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    const transferData = this.encodeTransferInstruction(
      Buffer.from(proof.publicSignals[0], "hex"), // merkle root
      nullifiers.map((n) => Buffer.from(n, "hex")),
      outputCommitments.map((c) => Buffer.from(c, "hex")),
      proof,
    );

    const transferIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: transferData,
    });

    const tx = new Transaction().add(computeIx, transferIx);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.payer,
    ]);

    return {
      nullifiers,
      outputCommitments,
      txSignature: sig,
    };
  }

  /**
   * Withdraw tokens from the pool to a public address.
   */
  async withdraw(
    amount: bigint,
    recipientTokenAccount: PublicKey,
    fee: bigint = 0n,
  ): Promise<WithdrawResult> {
    const { inputNotes, outputNotes } = await this.wallet.prepareWithdraw(
      amount,
      fee,
    );

    const proof = await this.prover.proveWithdraw({
      spendingKey: this.wallet.spendingKeyHex(),
      inputNotes,
      outputNotes,
      exitValue: amount,
      fee,
    });

    const nullifiers: [Hash32, Hash32] = [
      proof.publicSignals[1],
      proof.publicSignals[2],
    ];

    this.wallet.markSpent(inputNotes);

    // Build and submit the withdraw transaction on-chain
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool")],
      POOL_PROGRAM_ID,
    );

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    const withdrawData = this.encodeWithdrawInstruction(
      Buffer.from(proof.publicSignals[0], "hex"),
      nullifiers.map((n) => Buffer.from(n, "hex")),
      amount,
      proof,
    );

    const withdrawIx = new TransactionInstruction({
      programId: POOL_PROGRAM_ID,
      keys: [
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        { pubkey: NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: withdrawData,
    });

    const tx = new Transaction().add(computeIx, withdrawIx);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [
      this.payer,
    ]);

    return {
      nullifiers,
      exitAmount: amount,
      txSignature: sig,
    };
  }

  /**
   * Get pool status from on-chain state.
   */
  async getPoolStatus(tokenMint: PublicKey): Promise<PoolStatus> {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      POOL_PROGRAM_ID,
    );

    // Fetch and deserialize pool account data
    const accountInfo = await this.connection.getAccountInfo(poolPda);
    if (!accountInfo) {
      throw new Error("Pool not found");
    }

    // Deserialize using Anchor IDL layout
    // Anchor account data: 8-byte discriminator + fields
    const data = accountInfo.data;
    const offset = 8; // skip Anchor discriminator

    const totalDeposited = data.readBigUInt64LE(offset);
    const nextLeafIndex = data.readUInt32LE(offset + 8);
    const currentRootBytes = data.subarray(offset + 12, offset + 44);
    const currentRoot = Buffer.from(currentRootBytes).toString("hex");
    const isPaused = data[offset + 44] === 1;
    const epoch = data.readUInt32LE(offset + 45);

    return {
      poolAddress: poolPda,
      tokenMint,
      totalDeposited,
      nextLeafIndex,
      currentRoot,
      isPaused,
      epoch,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private encodeDepositInstruction(
    amount: bigint,
    commitment: Buffer,
    encryptedNote: Buffer,
  ): Buffer {
    // Anchor instruction discriminator for "deposit" = first 8 bytes of SHA256("global:deposit")
    const discriminator = Buffer.from([
      0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6,
    ]);

    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(amount);

    const commitmentBuf = Buffer.alloc(32);
    commitment.copy(commitmentBuf);

    // Vec<u8> encoding: 4-byte LE length prefix + data
    const noteLenBuf = Buffer.alloc(4);
    noteLenBuf.writeUInt32LE(encryptedNote.length);

    return Buffer.concat([
      discriminator,
      amountBuf,
      commitmentBuf,
      noteLenBuf,
      encryptedNote,
    ]);
  }

  private encodeTransferInstruction(
    merkleRoot: Buffer,
    nullifiers: Buffer[],
    outputCommitments: Buffer[],
    proof: { proof: any },
  ): Buffer {
    // Anchor instruction discriminator for "transfer" = first 8 bytes of SHA256("global:transfer")
    const discriminator = Buffer.from([
      0xa3, 0x34, 0xba, 0x5e, 0x51, 0x76, 0x90, 0x27,
    ]);

    const rootBuf = Buffer.alloc(32);
    merkleRoot.copy(rootBuf);

    const nullBuf = Buffer.concat(
      nullifiers.map((n) => {
        const b = Buffer.alloc(32);
        n.copy(b);
        return b;
      }),
    );

    const commitBuf = Buffer.concat(
      outputCommitments.map((c) => {
        const b = Buffer.alloc(32);
        c.copy(b);
        return b;
      }),
    );

    const proofBytes = this.serializeProof(proof.proof);

    return Buffer.concat([
      discriminator,
      rootBuf,
      nullBuf,
      commitBuf,
      proofBytes,
    ]);
  }

  private encodeWithdrawInstruction(
    merkleRoot: Buffer,
    nullifiers: Buffer[],
    exitValue: bigint,
    proof: { proof: any },
  ): Buffer {
    // Anchor instruction discriminator for "withdraw" = first 8 bytes of SHA256("global:withdraw")
    const discriminator = Buffer.from([
      0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22,
    ]);

    const rootBuf = Buffer.alloc(32);
    merkleRoot.copy(rootBuf);

    const nullBuf = Buffer.concat(
      nullifiers.map((n) => {
        const b = Buffer.alloc(32);
        n.copy(b);
        return b;
      }),
    );

    const exitBuf = Buffer.alloc(8);
    exitBuf.writeBigUInt64LE(exitValue);

    const proofBytes = this.serializeProof(proof.proof);

    return Buffer.concat([
      discriminator,
      rootBuf,
      nullBuf,
      exitBuf,
      proofBytes,
    ]);
  }

  private serializeProof(proof: any): Buffer {
    // Serialize Groth16 proof to fixed-size bytes: pi_a (64) + pi_b (128) + pi_c (64) = 256
    const parts: Buffer[] = [];
    for (const val of proof.piA) {
      const buf = Buffer.alloc(32);
      const bi = BigInt(val);
      for (let i = 0; i < 32; i++) {
        buf[i] = Number((bi >> BigInt(i * 8)) & 0xffn);
      }
      parts.push(buf);
    }
    for (const pair of proof.piB) {
      for (const val of pair) {
        const buf = Buffer.alloc(32);
        const bi = BigInt(val);
        for (let i = 0; i < 32; i++) {
          buf[i] = Number((bi >> BigInt(i * 8)) & 0xffn);
        }
        parts.push(buf);
      }
    }
    for (const val of proof.piC) {
      const buf = Buffer.alloc(32);
      const bi = BigInt(val);
      for (let i = 0; i < 32; i++) {
        buf[i] = Number((bi >> BigInt(i * 8)) & 0xffn);
      }
      parts.push(buf);
    }
    return Buffer.concat(parts);
  }
}
