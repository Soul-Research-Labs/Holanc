import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HolancWallet } from "./wallet";
import { HolancProver } from "./prover";
import {
  DepositResult,
  TransferResult,
  WithdrawResult,
  PoolStatus,
  Hash32,
} from "./types";
import { FailoverConnection, FailoverConfig, RpcEndpointConfig } from "./rpc";

/** Program IDs — must match deployed Anchor programs.
 * Can be overridden via environment variables for devnet/testnet deployments:
 *   POOL_PROGRAM_ID, VERIFIER_PROGRAM_ID, NULLIFIER_PROGRAM_ID, BRIDGE_PROGRAM_ID
 */
const POOL_PROGRAM_ID = new PublicKey(
  process.env["POOL_PROGRAM_ID"] ??
    "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
);
const VERIFIER_PROGRAM_ID = new PublicKey(
  process.env["VERIFIER_PROGRAM_ID"] ??
    "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
);
const NULLIFIER_PROGRAM_ID = new PublicKey(
  process.env["NULLIFIER_PROGRAM_ID"] ??
    "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);
const BRIDGE_PROGRAM_ID = new PublicKey(
  process.env["BRIDGE_PROGRAM_ID"] ??
    "H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K",
);

/**
 * HolancClient — main entry point for interacting with the Holanc privacy protocol.
 *
 * Provides high-level methods for deposits, private transfers, and withdrawals.
 * Manages proof generation client-side and submits transactions on-chain.
 */
export class HolancClient {
  private failover: FailoverConnection;
  private wallet: HolancWallet;
  private prover: HolancProver;
  private payer: Keypair;

  private constructor(
    failover: FailoverConnection,
    payer: Keypair,
    wallet: HolancWallet,
  ) {
    this.failover = failover;
    this.payer = payer;
    this.wallet = wallet;
    this.prover = new HolancProver();
  }

  /**
   * Create a client with a single RPC endpoint.
   */
  static async create(
    rpcUrl: string,
    payer: Keypair,
    wallet?: HolancWallet,
  ): Promise<HolancClient> {
    const failover = new FailoverConnection([rpcUrl]);
    const w = wallet ?? (await HolancWallet.random());
    return new HolancClient(failover, payer, w);
  }

  /**
   * Create a client with multi-RPC failover.
   *
   * @param endpoints - Array of RPC URLs or endpoint configs (with weight).
   * @param payer     - Keypair used to sign transactions.
   * @param config    - Failover options (cooldown, max failures, etc.).
   * @param wallet    - Optional existing wallet; creates a random one if omitted.
   */
  static async createWithFailover(
    endpoints: (string | RpcEndpointConfig)[],
    payer: Keypair,
    config?: FailoverConfig,
    wallet?: HolancWallet,
  ): Promise<HolancClient> {
    const failover = new FailoverConnection(endpoints, config);
    const w = wallet ?? (await HolancWallet.random());
    return new HolancClient(failover, payer, w);
  }

  /** Get the underlying Connection (the currently preferred healthy endpoint). */
  get connection(): Connection {
    return this.failover.primary;
  }

  /** Get RPC health status for monitoring. */
  rpcStatus() {
    return this.failover.status();
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
    const sig = await this.failover.exec((c) =>
      sendAndConfirmTransaction(c, tx, [this.payer]),
    );

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
    tokenMint: PublicKey,
    fee: bigint = 0n,
    feeCollector?: PublicKey,
    verificationKey?: PublicKey,
    nullifierManager?: PublicKey,
    nullifierPage?: PublicKey,
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

    // Derive all required PDAs — pool PDA uses [b"pool", tokenMint]
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      POOL_PROGRAM_ID,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      POOL_PROGRAM_ID,
    );
    const [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), poolPda.toBuffer()],
      POOL_PROGRAM_ID,
    );

    // Derive bridge commitment lock PDAs for each nullifier (may not exist)
    const [lockPda1] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lock"),
        poolPda.toBuffer(),
        Buffer.from(nullifiers[0], "hex"),
      ],
      BRIDGE_PROGRAM_ID,
    );
    const [lockPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lock"),
        poolPda.toBuffer(),
        Buffer.from(nullifiers[1], "hex"),
      ],
      BRIDGE_PROGRAM_ID,
    );

    // Derive nullifier manager PDA if not provided
    const nullMgr =
      nullifierManager ??
      PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_mgr"), poolPda.toBuffer()],
        NULLIFIER_PROGRAM_ID,
      )[0];

    // Nullifier page — caller should provide; default to page 0
    const nullPage =
      nullifierPage ??
      PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_page"), poolPda.toBuffer(), Buffer.alloc(8)],
        NULLIFIER_PROGRAM_ID,
      )[0];

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
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: vaultAuthPda, isSigner: false, isWritable: false },
        {
          pubkey: feeCollector ?? this.payer.publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: requireVerificationKey(verificationKey),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: nullMgr, isSigner: false, isWritable: true },
        { pubkey: nullPage, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: lockPda1, isSigner: false, isWritable: false },
        { pubkey: lockPda2, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: transferData,
    });

    const tx = new Transaction().add(computeIx, transferIx);
    const sig = await this.failover.exec((c) =>
      sendAndConfirmTransaction(c, tx, [this.payer]),
    );

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
    tokenMint: PublicKey,
    recipientTokenAccount: PublicKey,
    fee: bigint = 0n,
    feeCollector?: PublicKey,
    verificationKey?: PublicKey,
    nullifierManager?: PublicKey,
    nullifierPage?: PublicKey,
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

    // Derive all required PDAs — pool PDA uses [b"pool", tokenMint]
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      POOL_PROGRAM_ID,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      POOL_PROGRAM_ID,
    );
    const [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), poolPda.toBuffer()],
      POOL_PROGRAM_ID,
    );

    // Bridge commitment lock PDAs
    const [lockPda1] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lock"),
        poolPda.toBuffer(),
        Buffer.from(nullifiers[0], "hex"),
      ],
      BRIDGE_PROGRAM_ID,
    );
    const [lockPda2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lock"),
        poolPda.toBuffer(),
        Buffer.from(nullifiers[1], "hex"),
      ],
      BRIDGE_PROGRAM_ID,
    );

    const nullMgr =
      nullifierManager ??
      PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_mgr"), poolPda.toBuffer()],
        NULLIFIER_PROGRAM_ID,
      )[0];

    const nullPage =
      nullifierPage ??
      PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_page"), poolPda.toBuffer(), Buffer.alloc(8)],
        NULLIFIER_PROGRAM_ID,
      )[0];

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
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: vaultAuthPda, isSigner: false, isWritable: false },
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
        {
          pubkey: feeCollector ?? this.payer.publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: requireVerificationKey(verificationKey),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: NULLIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: nullMgr, isSigner: false, isWritable: true },
        { pubkey: nullPage, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: lockPda1, isSigner: false, isWritable: false },
        { pubkey: lockPda2, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: withdrawData,
    });

    const tx = new Transaction().add(computeIx, withdrawIx);
    const sig = await this.failover.exec((c) =>
      sendAndConfirmTransaction(c, tx, [this.payer]),
    );

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
    const accountInfo = await this.failover.exec((c) =>
      c.getAccountInfo(poolPda),
    );
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
    // Validate Groth16 proof structure before serialization.
    if (
      !Array.isArray(proof.piA) ||
      proof.piA.length < 2 ||
      !Array.isArray(proof.piB) ||
      proof.piB.length < 2 ||
      !proof.piB.every((p: any) => Array.isArray(p) && p.length >= 2) ||
      !Array.isArray(proof.piC) ||
      proof.piC.length < 2
    ) {
      throw new Error(
        "Invalid proof structure: expected piA[2+], piB[2+][2+], piC[2+]",
      );
    }

    // Serialize Groth16 proof to fixed-size bytes: pi_a (64) + pi_b (128) + pi_c (64) = 256
    // Field elements are encoded as 32-byte big-endian to match BN254 convention.
    const parts: Buffer[] = [];
    for (const val of proof.piA) {
      parts.push(bigintToBeBytes(BigInt(val)));
    }
    for (const pair of proof.piB) {
      for (const val of pair) {
        parts.push(bigintToBeBytes(BigInt(val)));
      }
    }
    for (const val of proof.piC) {
      parts.push(bigintToBeBytes(BigInt(val)));
    }
    return Buffer.concat(parts);
  }
}

/**
 * Guard that throws a clear error when a verificationKey is required but not supplied.
 * Prevents the all-zeros PublicKey.default from being silently passed on-chain.
 */
function requireVerificationKey(key?: PublicKey): PublicKey {
  if (!key) {
    throw new Error(
      "verificationKey is required for transfer/withdraw — pass the on-chain verification key account",
    );
  }
  return key;
}

/** Encode a BigInt as a 32-byte big-endian buffer. */
function bigintToBeBytes(bi: bigint): Buffer {
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(bi & 0xffn);
    bi >>= 8n;
  }
  return buf;
}
