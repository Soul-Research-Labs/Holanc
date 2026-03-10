/**
 * Nullifier program integration tests.
 *
 * Tests nullifier registration, double-spend detection, and epoch finalization.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";

const NULLIFIER_ID = new PublicKey(
  "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);
const POOL_ID = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");

describe("holanc-nullifier instructions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  let nullifierProgram: Program;
  let managerPda: PublicKey;
  let managerBump: number;

  // We use a fake pool key for testing (the PDA derivation just needs consistency)
  const mockPool = Keypair.generate();

  before(async () => {
    try {
      const idl = await Program.fetchIdl(NULLIFIER_ID, provider);
      if (idl) {
        nullifierProgram = new Program(idl, provider);
      }
    } catch {
      // IDL not available
    }

    [managerPda, managerBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_mgr"), mockPool.publicKey.toBuffer()],
      NULLIFIER_ID,
    );
  });

  describe("initialize", () => {
    it("initializes nullifier manager for a pool", async () => {
      if (!nullifierProgram) {
        console.log(
          "⚠ Skipping: nullifier IDL not available (run anchor build first)",
        );
        return;
      }

      await nullifierProgram.methods
        .initialize()
        .accounts({
          manager: managerPda,
          pool: mockPool.publicKey,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.pool.toBase58(), mockPool.publicKey.toBase58());
      assert.equal(mgr.authority.toBase58(), payer.publicKey.toBase58());
      assert.equal(mgr.currentEpoch.toNumber(), 0);
      assert.equal(mgr.totalNullifiers.toNumber(), 0);
    });
  });

  describe("register_nullifier", () => {
    let nullifierPagePda: PublicKey;
    const testNullifier = Buffer.alloc(32);

    before(() => {
      testNullifier[0] = 0xde;
      testNullifier[1] = 0xad;
      testNullifier[31] = 0x01;

      // Page index 0
      [nullifierPagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          mockPool.publicKey.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );
    });

    it("registers a nullifier successfully", async () => {
      if (!nullifierProgram) {
        console.log("⚠ Skipping: nullifier IDL not available");
        return;
      }

      await nullifierProgram.methods
        .registerNullifier([...testNullifier])
        .accounts({
          manager: managerPda,
          nullifierPage: nullifierPagePda,
          authority: payer.publicKey,
        })
        .rpc();

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.totalNullifiers.toNumber(), 1);
    });

    it("rejects duplicate nullifier (double-spend)", async () => {
      if (!nullifierProgram) return;

      try {
        await nullifierProgram.methods
          .registerNullifier([...testNullifier])
          .accounts({
            manager: managerPda,
            nullifierPage: nullifierPagePda,
            authority: payer.publicKey,
          })
          .rpc();
        assert.fail("Should have thrown NullifierAlreadySpent");
      } catch (err: any) {
        assert.include(err.toString(), "NullifierAlreadySpent");
      }
    });
  });

  describe("is_nullifier_spent", () => {
    it("checks a nullifier status", async () => {
      if (!nullifierProgram) {
        console.log("⚠ Skipping: nullifier IDL not available");
        return;
      }

      const [pagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          mockPool.publicKey.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      const spentNullifier = Buffer.alloc(32);
      spentNullifier[0] = 0xde;
      spentNullifier[1] = 0xad;
      spentNullifier[31] = 0x01;

      // This should succeed (view function — emits event)
      await nullifierProgram.methods
        .isNullifierSpent([...spentNullifier])
        .accounts({
          nullifierPage: pagePda,
        })
        .rpc();
    });
  });

  describe("register_nullifier_v2", () => {
    it("registers a v2 nullifier with chain_id and app_id", async () => {
      if (!nullifierProgram) {
        console.log("⚠ Skipping: nullifier IDL not available");
        return;
      }

      const v2Nullifier = Buffer.alloc(32);
      v2Nullifier[0] = 0xbe;
      v2Nullifier[1] = 0xef;

      const [pagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          mockPool.publicKey.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      await nullifierProgram.methods
        .registerNullifierV2([...v2Nullifier], new BN(1), new BN(100))
        .accounts({
          manager: managerPda,
          nullifierPage: pagePda,
          authority: payer.publicKey,
        })
        .rpc();

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.totalNullifiers.toNumber(), 2);
    });
  });

  describe("finalize_epoch", () => {
    it("finalizes an epoch with a nullifier root", async () => {
      if (!nullifierProgram) {
        console.log("⚠ Skipping: nullifier IDL not available");
        return;
      }

      const epoch = 0;
      const [epochPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("epoch"),
          mockPool.publicKey.toBuffer(),
          new BN(epoch).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      const epochRoot = Buffer.alloc(32);
      epochRoot.fill(0xaa);

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
      assert.equal(record.pool.toBase58(), mockPool.publicKey.toBase58());
      assert.equal(record.epoch.toNumber(), epoch);
      assert.deepEqual(Buffer.from(record.nullifierRoot), epochRoot);

      const mgr = await nullifierProgram.account.nullifierManager.fetch(
        managerPda,
      );
      assert.equal(mgr.currentEpoch.toNumber(), 1);
    });
  });
});
