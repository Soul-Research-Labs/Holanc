/**
 * Full-flow end-to-end integration test.
 *
 * Tests the complete privacy protocol flow:
 *   1. Initialize pool
 *   2. Deposit tokens (records commitment on-chain)
 *   3. Register nullifiers (prevents double-spend)
 *   4. Bridge: publish epoch root, receive foreign root
 *   5. Compliance: register oracle, disclose viewing key, submit wealth proof
 *   6. Admin: pause/unpause pool, update merkle root
 *
 * This test exercises cross-program interactions in sequence,
 * simulating a real user journey through the Holanc protocol.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

const POOL_ID = new PublicKey(
  process.env["POOL_PROGRAM_ID"] ?? "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
);
const NULLIFIER_ID = new PublicKey(
  process.env["NULLIFIER_PROGRAM_ID"] ?? "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);
const BRIDGE_ID = new PublicKey(
  process.env["BRIDGE_PROGRAM_ID"] ?? "H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K",
);
const COMPLIANCE_ID = new PublicKey(
  process.env["COMPLIANCE_PROGRAM_ID"] ?? "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
);

describe("holanc full-flow E2E", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;

  let poolProgram: Program;
  let nullifierProgram: Program;
  let bridgeProgram: Program;
  let complianceProgram: Program;

  let tokenMint: PublicKey;
  let poolPda: PublicKey;
  let poolBump: number;
  let vaultPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let depositorAta: PublicKey;

  let allProgramsReady = false;

  before(async () => {
    // Load all program IDLs
    const [poolIdl, nullifierIdl, bridgeIdl, complianceIdl] = await Promise.all(
      [
        Program.fetchIdl(POOL_ID, provider).catch(() => null),
        Program.fetchIdl(NULLIFIER_ID, provider).catch(() => null),
        Program.fetchIdl(BRIDGE_ID, provider).catch(() => null),
        Program.fetchIdl(COMPLIANCE_ID, provider).catch(() => null),
      ],
    );

    if (poolIdl) poolProgram = new Program(poolIdl, provider);
    if (nullifierIdl) nullifierProgram = new Program(nullifierIdl, provider);
    if (bridgeIdl) bridgeProgram = new Program(bridgeIdl, provider);
    if (complianceIdl) complianceProgram = new Program(complianceIdl, provider);

    allProgramsReady = !!(
      poolProgram &&
      nullifierProgram &&
      bridgeProgram &&
      complianceProgram
    );

    if (!allProgramsReady) {
      console.log(
        "⚠ Some program IDLs unavailable — partial tests may be skipped",
      );
    }

    // Create token mint + depositor ATA
    tokenMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9,
    );

    [poolPda, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), tokenMint.toBuffer()],
      POOL_ID,
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()],
      POOL_ID,
    );

    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth"), poolPda.toBuffer()],
      POOL_ID,
    );

    depositorAta = await createAccount(
      provider.connection,
      payer,
      tokenMint,
      payer.publicKey,
    );

    await mintTo(
      provider.connection,
      payer,
      tokenMint,
      depositorAta,
      payer,
      100_000_000_000, // 100 tokens
    );
  });

  // -----------------------------------------------------------------------
  // Stage 1: Pool initialization
  // -----------------------------------------------------------------------
  describe("Stage 1: Pool initialization", () => {
    it("initializes a fresh pool", async () => {
      if (!poolProgram) {
        console.log("⚠ Skipping: pool IDL not available");
        return;
      }

      await poolProgram.methods
        .initialize(poolBump)
        .accounts({
          pool: poolPda,
          tokenMint,
          vault: vaultPda,
          vaultAuthority: vaultAuthPda,
          authority: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const poolState = await poolProgram.account.poolState.fetch(poolPda);
      assert.equal(poolState.nextLeafIndex.toNumber(), 0);
      assert.equal(poolState.totalDeposited.toNumber(), 0);
      assert.isFalse(poolState.isPaused);
    });
  });

  // -----------------------------------------------------------------------
  // Stage 2: Deposits (multiple to build up the tree)
  // -----------------------------------------------------------------------
  describe("Stage 2: Multiple deposits", () => {
    const commitments: Buffer[] = [];

    it("deposits 5 tokens across 5 commitments", async () => {
      if (!poolProgram) return;

      for (let i = 0; i < 5; i++) {
        const commitment = Buffer.alloc(32);
        commitment[0] = i + 1;
        commitment[31] = 0xff - i;
        commitments.push(commitment);

        const encNote = Buffer.from(`encrypted_note_${i}`);

        await poolProgram.methods
          .deposit(new BN(1_000_000_000), [...commitment], encNote)
          .accounts({
            pool: poolPda,
            depositorTokenAccount: depositorAta,
            vault: vaultPda,
            depositor: payer.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }

      const poolState = await poolProgram.account.poolState.fetch(poolPda);
      assert.equal(poolState.nextLeafIndex.toNumber(), 5);
      assert.equal(poolState.totalDeposited.toNumber(), 5_000_000_000);

      // Verify SHA-256 root was updated (non-zero)
      const rootBytes = Buffer.from(poolState.sha256Root);
      const isNonZero = rootBytes.some((b: number) => b !== 0);
      assert.isTrue(
        isNonZero,
        "SHA-256 root should be non-zero after deposits",
      );
    });

    it("vault holds exactly 5 tokens", async () => {
      if (!poolProgram) return;

      const vault = await getAccount(provider.connection, vaultPda);
      assert.equal(vault.amount.toString(), "5000000000");
    });
  });

  // -----------------------------------------------------------------------
  // Stage 3: Merkle root update
  // -----------------------------------------------------------------------
  describe("Stage 3: Merkle root update", () => {
    it("authority updates the off-chain computed merkle root", async () => {
      if (!poolProgram) return;

      // Simulate an off-chain merkle root computation
      const merkleRoot = Buffer.alloc(32);
      merkleRoot.fill(0x42);

      await poolProgram.methods
        .updateRoot([...merkleRoot])
        .accounts({
          pool: poolPda,
          authority: payer.publicKey,
        })
        .rpc();

      const poolState = await poolProgram.account.poolState.fetch(poolPda);
      assert.deepEqual(Buffer.from(poolState.currentRoot), merkleRoot);
    });
  });

  // -----------------------------------------------------------------------
  // Stage 4: Nullifier management (simulating private transfers)
  // -----------------------------------------------------------------------
  describe("Stage 4: Nullifier management", () => {
    let managerPda: PublicKey;
    let nullifierPagePda: PublicKey;

    before(() => {
      [managerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_mgr"), poolPda.toBuffer()],
        NULLIFIER_ID,
      );

      [nullifierPagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          poolPda.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );
    });

    it("initializes nullifier manager for the pool", async () => {
      if (!nullifierProgram) return;

      await nullifierProgram.methods
        .initialize()
        .accounts({
          manager: managerPda,
          pool: poolPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.pool.toBase58(), poolPda.toBase58());
    });

    it("registers nullifiers for spent notes", async () => {
      if (!nullifierProgram) return;

      const nullifiers = [Buffer.alloc(32, 0x11), Buffer.alloc(32, 0x22)];

      for (const nf of nullifiers) {
        await nullifierProgram.methods
          .registerNullifier([...nf])
          .accounts({
            manager: managerPda,
            nullifierPage: nullifierPagePda,
            authority: payer.publicKey,
          })
          .rpc();
      }

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.totalNullifiers.toNumber(), 2);
    });

    it("prevents double-spend of same nullifier", async () => {
      if (!nullifierProgram) return;

      try {
        await nullifierProgram.methods
          .registerNullifier(Array(32).fill(0x11))
          .accounts({
            manager: managerPda,
            nullifierPage: nullifierPagePda,
            authority: payer.publicKey,
          })
          .rpc();
        assert.fail("Double-spend should fail");
      } catch (err: any) {
        assert.include(err.toString(), "NullifierAlreadySpent");
      }
    });

    it("finalizes epoch with accumulated nullifiers", async () => {
      if (!nullifierProgram) return;

      const [epochPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("epoch"),
          poolPda.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      const epochRoot = Buffer.alloc(32);
      epochRoot.fill(0xab);

      await nullifierProgram.methods
        .finalizeEpoch([...epochRoot])
        .accounts({
          manager: managerPda,
          epochRecord: epochPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await nullifierProgram.account.epochRecord.fetch(epochPda);
      assert.deepEqual(Buffer.from(record.nullifierRoot), epochRoot);
    });
  });

  // -----------------------------------------------------------------------
  // Stage 5: Bridge (cross-chain epoch root publishing)
  // -----------------------------------------------------------------------
  describe("Stage 5: Cross-chain bridge", () => {
    let bridgePda: PublicKey;

    before(() => {
      [bridgePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge"), poolPda.toBuffer()],
        BRIDGE_ID,
      );
    });

    it("initializes bridge for the pool", async () => {
      if (!bridgeProgram) return;

      await bridgeProgram.methods
        .initialize(new BN(1), new BN(200)) // Solana chain, app 200
        .accounts({
          bridgeConfig: bridgePda,
          pool: poolPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      assert.equal(config.localChainId.toNumber(), 1);
      assert.isTrue(config.isActive);
    });

    it("publishes epoch root for cross-chain relay", async () => {
      if (!bridgeProgram) return;

      const config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      const [outboundPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("outbound"),
          poolPda.toBuffer(),
          config.epochCounter.toArrayLike(Buffer, "le", 8),
        ],
        BRIDGE_ID,
      );

      const epochRoot = Buffer.alloc(32, 0xab);

      await bridgeProgram.methods
        .publishEpochRoot(new BN(0), [...epochRoot], new BN(2))
        .accounts({
          bridgeConfig: bridgePda,
          outboundMessage: outboundPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const msg = await bridgeProgram.account.outboundMessage.fetch(
        outboundPda,
      );
      assert.equal(msg.nullifierCount.toNumber(), 2);
    });

    it("receives epoch root from Eclipse", async () => {
      if (!bridgeProgram) return;

      const [foreignRootPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("foreign_root"),
          poolPda.toBuffer(),
          new BN(2).toArrayLike(Buffer, "le", 8), // Eclipse
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        BRIDGE_ID,
      );

      const foreignRoot = Buffer.alloc(32, 0xcc);
      const vaaHash = Buffer.alloc(32, 0xdd);

      await bridgeProgram.methods
        .receiveEpochRoot(new BN(2), new BN(0), [...foreignRoot], new BN(5), [
          ...vaaHash,
        ])
        .accounts({
          bridgeConfig: bridgePda,
          foreignRoot: foreignRootPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const root = await bridgeProgram.account.foreignRoot.fetch(
        foreignRootPda,
      );
      assert.equal(root.sourceChain.toNumber(), 2);
    });
  });

  // -----------------------------------------------------------------------
  // Stage 6: Compliance (oracle + disclosure + wealth proof)
  // -----------------------------------------------------------------------
  describe("Stage 6: Compliance features", () => {
    let compliancePda: PublicKey;
    const oracle = Keypair.generate();

    before(async () => {
      [compliancePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("compliance"), poolPda.toBuffer()],
        COMPLIANCE_ID,
      );

      const sig = await provider.connection.requestAirdrop(
        oracle.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
    });

    it("initializes compliance for the pool", async () => {
      if (!complianceProgram) return;

      await complianceProgram.methods
        .initialize({ optionalDisclosure: {} })
        .accounts({
          complianceConfig: compliancePda,
          pool: poolPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await complianceProgram.account.complianceConfig.fetch(
        compliancePda,
      );
      assert.isTrue(config.isActive);
    });

    it("registers an oracle and discloses viewing key", async () => {
      if (!complianceProgram) return;

      const [oraclePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("oracle"),
          poolPda.toBuffer(),
          oracle.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      const oracleName = Buffer.alloc(32);
      Buffer.from("ChainwatchOracle").copy(oracleName);

      await complianceProgram.methods
        .registerOracle(oracle.publicKey, [...oracleName], {
          canView: true,
          canRequestWealthProof: true,
          canFlag: true,
        })
        .accounts({
          complianceConfig: compliancePda,
          oracleRecord: oraclePda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Now disclose viewing key
      const [disclosurePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("disclosure"),
          poolPda.toBuffer(),
          payer.publicKey.toBuffer(),
          oracle.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      await complianceProgram.methods
        .discloseViewingKey(Buffer.from("aes256_encrypted_vk_payload"), {
          full: {},
        })
        .accounts({
          complianceConfig: compliancePda,
          oracleRecord: oraclePda,
          disclosureRecord: disclosurePda,
          discloser: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const disclosure = await complianceProgram.account.disclosureRecord.fetch(
        disclosurePda,
      );
      assert.isFalse(disclosure.isRevoked);
    });

    it("submits a wealth proof and verifies attestation", async () => {
      if (!complianceProgram) return;

      const [wealthPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("wealth"), poolPda.toBuffer(), payer.publicKey.toBuffer()],
        COMPLIANCE_ID,
      );

      await complianceProgram.methods
        .submitWealthProof(
          new BN(10_000_000_000), // 10 token threshold
          Buffer.from("zk_snark_wealth_proof"),
          7,
        )
        .accounts({
          complianceConfig: compliancePda,
          wealthAttestation: wealthPda,
          prover: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const attestation =
        await complianceProgram.account.wealthAttestation.fetch(wealthPda);
      assert.isTrue(attestation.isValid);
      assert.equal(attestation.threshold.toNumber(), 10_000_000_000);
    });
  });

  // -----------------------------------------------------------------------
  // Stage 7: Admin controls
  // -----------------------------------------------------------------------
  describe("Stage 7: Admin controls", () => {
    it("pauses pool, blocks deposits, then unpauses", async () => {
      if (!poolProgram) return;

      // Pause
      await poolProgram.methods
        .setPaused(true)
        .accounts({ pool: poolPda, authority: payer.publicKey })
        .rpc();

      // Deposit should fail
      const commitment = Buffer.alloc(32, 0x99);
      try {
        await poolProgram.methods
          .deposit(new BN(1_000_000_000), [...commitment], Buffer.alloc(0))
          .accounts({
            pool: poolPda,
            depositorTokenAccount: depositorAta,
            vault: vaultPda,
            depositor: payer.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Deposit should fail while paused");
      } catch (err: any) {
        assert.include(err.toString(), "PoolPaused");
      }

      // Unpause
      await poolProgram.methods
        .setPaused(false)
        .accounts({ pool: poolPda, authority: payer.publicKey })
        .rpc();

      // Deposit should work again
      await poolProgram.methods
        .deposit(new BN(1_000_000_000), [...commitment], Buffer.alloc(0))
        .accounts({
          pool: poolPda,
          depositorTokenAccount: depositorAta,
          vault: vaultPda,
          depositor: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const poolState = await poolProgram.account.poolState.fetch(poolPda);
      assert.equal(poolState.nextLeafIndex.toNumber(), 6); // 5 from stage 2 + 1
    });
  });
});
