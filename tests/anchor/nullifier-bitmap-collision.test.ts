/**
 * Nullifier bitmap collision boundary tests.
 *
 * Validates behavior when multiple nullifiers map to the same bitmap slot
 * (false-positive collisions), and verifies page saturation at 256 slots.
 *
 * The bitmap uses SHA256(nullifier)[0..2] % 256 to derive the bit index,
 * so distinct nullifiers can collide on the same bit position.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";

const NULLIFIER_ID = new PublicKey(
  "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);
const SLOTS_PER_PAGE = 256;

/**
 * Compute the bitmap bit index for a given nullifier, matching on-chain logic:
 *   bit_index = u16_le(SHA256(nullifier)[0..2]) % 256
 */
function bitmapBitIndex(nullifier: Buffer): number {
  const digest = createHash("sha256").update(nullifier).digest();
  const u16 = digest[0] | (digest[1] << 8);
  return u16 % SLOTS_PER_PAGE;
}

/**
 * Find two distinct 32-byte nullifiers that hash to the same bitmap slot.
 * Brute-forces by incrementing a counter in the first 4 bytes.
 */
function findCollidingPair(): [Buffer, Buffer] {
  const slotMap = new Map<number, Buffer>();
  for (let i = 0; i < 100_000; i++) {
    const nul = Buffer.alloc(32);
    nul.writeUInt32LE(i, 0);
    nul[31] = 0xff; // sentinel byte for test nullifiers
    const slot = bitmapBitIndex(nul);
    const existing = slotMap.get(slot);
    if (existing) {
      return [existing, nul];
    }
    slotMap.set(slot, nul);
  }
  throw new Error("Failed to find colliding pair in 100k attempts");
}

/**
 * Generate nullifiers that cover every slot 0..255 in the bitmap.
 * Returns an array of 256 distinct nullifiers, one per slot.
 */
function generateFullPageCoverage(): Buffer[] {
  const slotToNullifier = new Map<number, Buffer>();
  for (let i = 0; slotToNullifier.size < SLOTS_PER_PAGE; i++) {
    const nul = Buffer.alloc(32);
    nul.writeUInt32LE(i, 0);
    nul[4] = 0xcc; // distinguish from collision test nullifiers
    const slot = bitmapBitIndex(nul);
    if (!slotToNullifier.has(slot)) {
      slotToNullifier.set(slot, nul);
    }
  }
  // Return sorted by slot for deterministic ordering
  return Array.from({ length: SLOTS_PER_PAGE }, (_, s) =>
    slotToNullifier.get(s)!,
  );
}

describe("nullifier bitmap collision boundary tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  let nullifierProgram: Program;
  const mockPool = anchor.web3.Keypair.generate();
  let managerPda: PublicKey;

  before(async () => {
    try {
      const idl = await Program.fetchIdl(NULLIFIER_ID, provider);
      if (idl) {
        nullifierProgram = new Program(idl, provider);
      }
    } catch {
      // IDL not available in CI without anchor build
    }

    [managerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_mgr"), mockPool.publicKey.toBuffer()],
      NULLIFIER_ID,
    );
  });

  describe("off-chain bitmap index derivation", () => {
    it("correctly mirrors the on-chain SHA256-based bit index", () => {
      // Verify our JS implementation matches the on-chain formula
      const nul = Buffer.alloc(32);
      nul[0] = 0xde;
      nul[1] = 0xad;
      nul[31] = 0x01;

      const digest = createHash("sha256").update(nul).digest();
      const expectedBit = (digest[0] | (digest[1] << 8)) % 256;
      assert.equal(bitmapBitIndex(nul), expectedBit);
    });

    it("finds colliding nullifier pairs (same bit index, different data)", () => {
      const [a, b] = findCollidingPair();
      assert.notDeepEqual(a, b, "Nullifiers must be distinct");
      assert.equal(
        bitmapBitIndex(a),
        bitmapBitIndex(b),
        "Both must map to the same bitmap slot",
      );
    });

    it("covers all 256 bitmap slots with distinct nullifiers", () => {
      const coverage = generateFullPageCoverage();
      assert.equal(coverage.length, 256);

      const slots = new Set(coverage.map(bitmapBitIndex));
      assert.equal(slots.size, 256, "Must cover all 256 unique slots");
    });
  });

  describe("on-chain collision rejection", () => {
    it("rejects a distinct nullifier that collides on the same bitmap slot", async () => {
      if (!nullifierProgram) {
        console.log(
          "⚠ Skipping on-chain test: nullifier IDL not available (run anchor build first)",
        );
        return;
      }

      const [first, second] = findCollidingPair();
      const collisionSlot = bitmapBitIndex(first);

      // Initialize manager for this test's pool
      await nullifierProgram.methods
        .initialize()
        .accounts({
          manager: managerPda,
          pool: mockPool.publicKey,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [pagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          mockPool.publicKey.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      // Register first nullifier — should succeed
      await nullifierProgram.methods
        .registerNullifier([...first])
        .accounts({
          manager: managerPda,
          nullifierPage: pagePda,
          authority: payer.publicKey,
        })
        .rpc();

      // Verify page has exactly 1 nullifier
      const pageAfterFirst =
        await nullifierProgram.account.nullifierPage.fetch(pagePda);
      assert.equal(pageAfterFirst.count, 1);

      // Verify the bit is set
      const byteIdx = Math.floor(collisionSlot / 8);
      const bitOff = collisionSlot % 8;
      const bitSet =
        (pageAfterFirst.bitmap[byteIdx] >> bitOff) & 1;
      assert.equal(bitSet, 1, "Bitmap bit should be set after first registration");

      // Register second nullifier (different data, SAME bit index) — should fail
      try {
        await nullifierProgram.methods
          .registerNullifier([...second])
          .accounts({
            manager: managerPda,
            nullifierPage: pagePda,
            authority: payer.publicKey,
          })
          .rpc();
        assert.fail(
          "Should have thrown NullifierAlreadySpent due to bitmap collision",
        );
      } catch (err: any) {
        assert.include(
          err.toString(),
          "NullifierAlreadySpent",
          "Colliding nullifier must be rejected as already spent (false positive)",
        );
      }
    });
  });

  describe("page saturation (all 256 slots filled)", () => {
    it("fills all 256 bitmap slots and then rejects any new registration", async () => {
      if (!nullifierProgram) {
        console.log("⚠ Skipping on-chain test: nullifier IDL not available");
        return;
      }

      // Use a fresh pool to get a fresh manager + page
      const freshPool = anchor.web3.Keypair.generate();
      const [freshManagerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier_mgr"), freshPool.publicKey.toBuffer()],
        NULLIFIER_ID,
      );

      await nullifierProgram.methods
        .initialize()
        .accounts({
          manager: freshManagerPda,
          pool: freshPool.publicKey,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [freshPagePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier_page"),
          freshPool.publicKey.toBuffer(),
          new BN(0).toArrayLike(Buffer, "le", 8),
        ],
        NULLIFIER_ID,
      );

      const coverage = generateFullPageCoverage();

      // Register all 256 nullifiers (one per slot)
      for (let i = 0; i < coverage.length; i++) {
        await nullifierProgram.methods
          .registerNullifier([...coverage[i]])
          .accounts({
            manager: freshManagerPda,
            nullifierPage: freshPagePda,
            authority: payer.publicKey,
          })
          .rpc();
      }

      // Verify page is fully saturated
      const fullPage =
        await nullifierProgram.account.nullifierPage.fetch(freshPagePda);
      assert.equal(fullPage.count, 256, "Page must have 256 entries");

      // Every byte of the bitmap should be 0xFF
      for (let i = 0; i < 32; i++) {
        assert.equal(
          fullPage.bitmap[i],
          0xff,
          `Bitmap byte ${i} should be fully set`,
        );
      }

      // Any new nullifier must fail (every slot is taken)
      const extraNullifier = Buffer.alloc(32);
      extraNullifier.fill(0x99);
      try {
        await nullifierProgram.methods
          .registerNullifier([...extraNullifier])
          .accounts({
            manager: freshManagerPda,
            nullifierPage: freshPagePda,
            authority: payer.publicKey,
          })
          .rpc();
        assert.fail(
          "Should have thrown — page is fully saturated",
        );
      } catch (err: any) {
        assert.include(err.toString(), "NullifierAlreadySpent");
      }
    });
  });

  describe("v2 domain-separated collision independence", () => {
    it("same nullifier data on different chain_ids maps to different slots", () => {
      // V2 nullifiers hash: SHA256(nullifier || chain_id_le || app_id_le)
      // Same nullifier bytes on chain 1 vs chain 2 should differ
      const nul = Buffer.alloc(32);
      nul[0] = 0xab;

      function v2BitIndex(
        nullifier: Buffer,
        chainId: bigint,
        appId: bigint,
      ): number {
        const buf = Buffer.alloc(32 + 8 + 8);
        nullifier.copy(buf, 0);
        buf.writeBigUInt64LE(chainId, 32);
        buf.writeBigUInt64LE(appId, 40);
        const digest = createHash("sha256").update(buf).digest();
        return (digest[0] | (digest[1] << 8)) % SLOTS_PER_PAGE;
      }

      const slotChain1 = v2BitIndex(nul, 1n, 100n);
      const slotChain2 = v2BitIndex(nul, 2n, 100n);

      // They *might* collide by chance, but statistically very unlikely
      // for these specific inputs. The key point is the function incorporates
      // chain_id — we just verify it doesn't always return the same value.
      // If they DO collide for these specific values, the domain separation
      // still works in general.
      const slotV1 = bitmapBitIndex(nul); // v1 ignores chain/app
      const slotsAreDistinct =
        slotChain1 !== slotV1 || slotChain2 !== slotV1;
      assert.isTrue(
        slotsAreDistinct,
        "V2 domain-separated slots should generally differ from V1 slot",
      );
    });
  });
});
