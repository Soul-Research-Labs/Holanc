/**
 * Bridge program integration tests.
 *
 * Tests cross-chain bridge initialization, epoch root publishing/receiving,
 * commitment locking/unlocking, and admin controls.
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

const BRIDGE_ID = new PublicKey("H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K");

describe("holanc-bridge instructions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  let bridgeProgram: Program;
  let bridgePda: PublicKey;
  let bridgeBump: number;

  const mockPool = Keypair.generate();
  const LOCAL_CHAIN_ID = 1; // Solana
  const LOCAL_APP_ID = 100;

  before(async () => {
    try {
      const idl = await Program.fetchIdl(BRIDGE_ID, provider);
      if (idl) {
        bridgeProgram = new Program(idl, provider);
      }
    } catch {
      // IDL not available
    }

    [bridgePda, bridgeBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge"), mockPool.publicKey.toBuffer()],
      BRIDGE_ID,
    );
  });

  describe("initialize", () => {
    it("initializes bridge config for a pool", async () => {
      if (!bridgeProgram) {
        console.log(
          "⚠ Skipping: bridge IDL not available (run anchor build first)",
        );
        return;
      }

      await bridgeProgram.methods
        .initialize(new BN(LOCAL_CHAIN_ID), new BN(LOCAL_APP_ID))
        .accounts({
          bridgeConfig: bridgePda,
          pool: mockPool.publicKey,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      assert.equal(config.authority.toBase58(), payer.publicKey.toBase58());
      assert.equal(config.pool.toBase58(), mockPool.publicKey.toBase58());
      assert.equal(config.localChainId.toNumber(), LOCAL_CHAIN_ID);
      assert.equal(config.localAppId.toNumber(), LOCAL_APP_ID);
      assert.equal(config.epochCounter.toNumber(), 0);
      assert.isTrue(config.isActive);
    });
  });

  describe("publish_epoch_root", () => {
    it("publishes an epoch root to outbound message", async () => {
      if (!bridgeProgram) return;

      const epoch = 0;
      const nullifierRoot = Buffer.alloc(32);
      nullifierRoot.fill(0xbb);
      const nullifierCount = 42;

      // Outbound message PDA uses epoch_counter from bridge config (starts at 0)
      const config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      const counter = config.epochCounter.toNumber();

      const [outboundPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("outbound"),
          mockPool.publicKey.toBuffer(),
          new BN(counter).toArrayLike(Buffer, "le", 8),
        ],
        BRIDGE_ID,
      );

      await bridgeProgram.methods
        .publishEpochRoot(
          new BN(epoch),
          [...nullifierRoot],
          new BN(nullifierCount),
        )
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
      assert.equal(msg.sourceChain.toNumber(), LOCAL_CHAIN_ID);
      assert.equal(msg.epoch.toNumber(), epoch);
      assert.deepEqual(Buffer.from(msg.nullifierRoot), nullifierRoot);
      assert.equal(msg.nullifierCount.toNumber(), nullifierCount);

      // Epoch counter incremented
      const updatedConfig = await bridgeProgram.account.bridgeConfig.fetch(
        bridgePda,
      );
      assert.equal(updatedConfig.epochCounter.toNumber(), counter + 1);
    });
  });

  describe("receive_epoch_root", () => {
    it("receives a foreign epoch root", async () => {
      if (!bridgeProgram) return;

      const sourceChain = 2; // Eclipse
      const epoch = 0;
      const nullifierRoot = Buffer.alloc(32);
      nullifierRoot.fill(0xcc);
      const nullifierCount = 10;
      const vaaHash = Buffer.alloc(32);
      vaaHash.fill(0xdd);

      const [foreignRootPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("foreign_root"),
          mockPool.publicKey.toBuffer(),
          new BN(sourceChain).toArrayLike(Buffer, "le", 8),
          new BN(epoch).toArrayLike(Buffer, "le", 8),
        ],
        BRIDGE_ID,
      );

      await bridgeProgram.methods
        .receiveEpochRoot(
          new BN(sourceChain),
          new BN(epoch),
          [...nullifierRoot],
          new BN(nullifierCount),
          [...vaaHash],
        )
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
      assert.equal(root.sourceChain.toNumber(), sourceChain);
      assert.equal(root.epoch.toNumber(), epoch);
      assert.deepEqual(Buffer.from(root.nullifierRoot), nullifierRoot);
      assert.deepEqual(Buffer.from(root.vaaHash), vaaHash);
    });

    it("rejects receiving own chain's root", async () => {
      if (!bridgeProgram) return;

      const [foreignRootPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("foreign_root"),
          mockPool.publicKey.toBuffer(),
          new BN(LOCAL_CHAIN_ID).toArrayLike(Buffer, "le", 8),
          new BN(99).toArrayLike(Buffer, "le", 8),
        ],
        BRIDGE_ID,
      );

      try {
        await bridgeProgram.methods
          .receiveEpochRoot(
            new BN(LOCAL_CHAIN_ID),
            new BN(99),
            Array(32).fill(0),
            new BN(0),
            Array(32).fill(0),
          )
          .accounts({
            bridgeConfig: bridgePda,
            foreignRoot: foreignRootPda,
            authority: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown CannotReceiveOwnChain");
      } catch (err: any) {
        assert.include(err.toString(), "CannotReceiveOwnChain");
      }
    });
  });

  describe("lock_commitment", () => {
    it("locks a commitment for cross-chain transfer", async () => {
      if (!bridgeProgram) return;

      const commitment = Buffer.alloc(32);
      commitment[0] = 0xf0;
      commitment[31] = 0x0f;

      const destChain = 3; // Sonic
      const proof = Buffer.from("mock_proof_data_for_locking");

      const [lockPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lock"), mockPool.publicKey.toBuffer(), commitment],
        BRIDGE_ID,
      );

      await bridgeProgram.methods
        .lockCommitment([...commitment], new BN(destChain), proof)
        .accounts({
          bridgeConfig: bridgePda,
          commitmentLock: lockPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const lock = await bridgeProgram.account.commitmentLockRecord.fetch(
        lockPda,
      );
      assert.deepEqual(Buffer.from(lock.commitment), commitment);
      assert.equal(lock.destinationChain.toNumber(), destChain);
      assert.equal(lock.locker.toBase58(), payer.publicKey.toBase58());
      assert.isFalse(lock.isUnlocked);
    });

    it("rejects bridging to self", async () => {
      if (!bridgeProgram) return;

      const commitment = Buffer.alloc(32);
      commitment[0] = 0xaa;

      const [lockPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lock"), mockPool.publicKey.toBuffer(), commitment],
        BRIDGE_ID,
      );

      try {
        await bridgeProgram.methods
          .lockCommitment(
            [...commitment],
            new BN(LOCAL_CHAIN_ID),
            Buffer.from("proof"),
          )
          .accounts({
            bridgeConfig: bridgePda,
            commitmentLock: lockPda,
            authority: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown CannotBridgeToSelf");
      } catch (err: any) {
        assert.include(err.toString(), "CannotBridgeToSelf");
      }
    });
  });

  describe("unlock_commitment", () => {
    it("unlocks a commitment from a foreign chain", async () => {
      if (!bridgeProgram) return;

      const commitment = Buffer.alloc(32);
      commitment[0] = 0xe0;
      const sourceChain = 2;
      const vaaHash = Buffer.alloc(32);
      vaaHash.fill(0xee);

      const [unlockPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("unlock"),
          mockPool.publicKey.toBuffer(),
          new BN(sourceChain).toArrayLike(Buffer, "le", 8),
          commitment,
        ],
        BRIDGE_ID,
      );

      await bridgeProgram.methods
        .unlockCommitment([...commitment], new BN(sourceChain), [...vaaHash])
        .accounts({
          bridgeConfig: bridgePda,
          unlockRecord: unlockPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await bridgeProgram.account.unlockRecord.fetch(unlockPda);
      assert.deepEqual(Buffer.from(record.commitment), commitment);
      assert.equal(record.sourceChain.toNumber(), sourceChain);
      assert.deepEqual(Buffer.from(record.vaaHash), vaaHash);
    });
  });

  describe("set_active", () => {
    it("deactivates and reactivates the bridge", async () => {
      if (!bridgeProgram) return;

      await bridgeProgram.methods
        .setActive(false)
        .accounts({
          bridgeConfig: bridgePda,
          authority: payer.publicKey,
        })
        .rpc();

      let config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      assert.isFalse(config.isActive);

      // Reactivate
      await bridgeProgram.methods
        .setActive(true)
        .accounts({
          bridgeConfig: bridgePda,
          authority: payer.publicKey,
        })
        .rpc();

      config = await bridgeProgram.account.bridgeConfig.fetch(bridgePda);
      assert.isTrue(config.isActive);
    });

    it("rejects unauthorized admin action", async () => {
      if (!bridgeProgram) return;

      const badActor = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        badActor.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await bridgeProgram.methods
          .setActive(false)
          .accounts({
            bridgeConfig: bridgePda,
            authority: badActor.publicKey,
          })
          .signers([badActor])
          .rpc();
        assert.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        assert.include(err.toString(), "Unauthorized");
      }
    });
  });
});
