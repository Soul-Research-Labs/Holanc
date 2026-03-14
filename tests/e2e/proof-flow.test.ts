/**
 * End-to-end ZK proof flow test.
 *
 * Exercises the complete off-chain privacy protocol flow:
 *   1. Create notes with proper commitments (Poseidon hash)
 *   2. Build a local Merkle tree
 *   3. Generate transfer circuit witness with valid inputs
 *   4. Verify value conservation, nullifier derivation, Merkle inclusion
 *
 * This test works entirely off-chain using circomlibjs for Poseidon
 * and snarkjs WASM for witness generation (requires compiled circuits).
 */

import * as path from "path";
import * as fs from "fs";
import { assert } from "chai";

const BUILD_DIR = path.resolve(__dirname, "../../circuits/build");

async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon(inputs.map((x) => F.e(x))));
}

/**
 * Build an incremental Poseidon Merkle tree and return the root + proofs.
 */
async function buildMerkleTree(
  leaves: bigint[],
  depth: number,
): Promise<{
  root: bigint;
  proofs: Array<{ pathElements: bigint[]; pathIndices: bigint[] }>;
}> {
  const EMPTY = 0n;
  const hash = poseidonHash;

  // Initialize tree as a flat array of layers
  const layers: bigint[][] = [];
  const numLeaves = 1 << depth;

  // Pad leaves to next power of 2
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < numLeaves) {
    paddedLeaves.push(EMPTY);
  }

  layers.push(paddedLeaves);

  // Build layers bottom-up
  for (let i = 0; i < depth; i++) {
    const prevLayer = layers[i];
    const nextLayer: bigint[] = [];
    for (let j = 0; j < prevLayer.length; j += 2) {
      nextLayer.push(await hash([prevLayer[j], prevLayer[j + 1]]));
    }
    layers.push(nextLayer);
  }

  const root = layers[depth][0];

  // Extract proofs for each original leaf
  const proofs = leaves.map((_, leafIdx) => {
    const pathElements: bigint[] = [];
    const pathIndices: bigint[] = [];
    let idx = leafIdx;

    for (let level = 0; level < depth; level++) {
      const siblingIdx = idx ^ 1;
      pathElements.push(layers[level][siblingIdx]);
      pathIndices.push(BigInt(idx & 1));
      idx >>= 1;
    }

    return { pathElements, pathIndices };
  });

  return { root, proofs };
}

describe("ZK proof flow E2E", () => {
  const TREE_DEPTH = 20;

  describe("deposit → Merkle tree → transfer flow (off-chain)", () => {
    it("computes valid note commitments matching circuit expectations", async () => {
      const owner = 12345n;
      const value = 1000000n;
      const assetId = 1n;
      const blinding = 99999n;

      // NoteCommitment = Poseidon(owner, value, asset_id, blinding)
      const commitment = await poseidonHash([owner, value, assetId, blinding]);
      assert.isTrue(commitment > 0n, "Commitment should be non-zero");

      // Same inputs should always produce the same commitment (deterministic)
      const commitment2 = await poseidonHash([owner, value, assetId, blinding]);
      assert.equal(commitment, commitment2);
    });

    it("derives nullifiers correctly (V1 and V2)", async () => {
      const spendingKey = 42n;
      const owner = 12345n;
      const value = 1000n;
      const assetId = 1n;
      const blinding = 555n;

      const commitment = await poseidonHash([owner, value, assetId, blinding]);

      // NullifierV1 = Poseidon(spending_key, commitment)
      const nfV1 = await poseidonHash([spendingKey, commitment]);
      assert.isTrue(nfV1 > 0n);

      // NullifierV2 = Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))
      const inner = await poseidonHash([spendingKey, commitment]);
      const domain = await poseidonHash([1n, 100n]); // Solana chain=1, app=100
      const nfV2 = await poseidonHash([inner, domain]);
      assert.isTrue(nfV2 > 0n);
      assert.notEqual(nfV1, nfV2, "V1 and V2 nullifiers should differ");
    });

    it("builds a valid small Merkle tree and generates inclusion proofs", async () => {
      // Deposit 4 notes
      const notes = [
        { owner: 111n, value: 500n, assetId: 1n, blinding: 1001n },
        { owner: 222n, value: 300n, assetId: 1n, blinding: 1002n },
        { owner: 333n, value: 200n, assetId: 1n, blinding: 1003n },
        { owner: 444n, value: 100n, assetId: 1n, blinding: 1004n },
      ];

      const commitments = await Promise.all(
        notes.map((n) =>
          poseidonHash([n.owner, n.value, n.assetId, n.blinding]),
        ),
      );

      // Use depth=4 for testing speed
      const { root, proofs } = await buildMerkleTree(commitments, 4);
      assert.isTrue(root > 0n, "Root should be non-zero");
      assert.equal(proofs.length, 4);

      // Verify each proof by recomputing the root
      for (let i = 0; i < commitments.length; i++) {
        let current = commitments[i];
        for (let level = 0; level < 4; level++) {
          const sibling = proofs[i].pathElements[level];
          const isRight = proofs[i].pathIndices[level];
          current =
            isRight === 0n
              ? await poseidonHash([current, sibling])
              : await poseidonHash([sibling, current]);
        }
        assert.equal(
          current,
          root,
          `Proof for leaf ${i} should reconstruct the root`,
        );
      }
    });

    it("simulates a complete transfer: 2-in-2-out with value conservation", async () => {
      const spendingKey = 42n;
      const ownerPub = await poseidonHash([spendingKey, 0n]);
      const assetId = 1n;

      // Two input notes: 500 + 500 = 1000
      const inputNotes = [
        { owner: ownerPub, value: 500n, assetId, blinding: 111n },
        { owner: ownerPub, value: 500n, assetId, blinding: 222n },
      ];

      const inputCommitments = await Promise.all(
        inputNotes.map((n) =>
          poseidonHash([n.owner, n.value, n.assetId, n.blinding]),
        ),
      );

      // Nullifiers
      const nullifiers = await Promise.all(
        inputCommitments.map((cm) => poseidonHash([spendingKey, cm])),
      );

      // Two output notes: 700 to recipient + 290 change + 10 fee = 1000
      const recipientOwner = 88888n;
      const outputNotes = [
        { owner: recipientOwner, value: 700n, assetId, blinding: 333n },
        { owner: ownerPub, value: 290n, assetId, blinding: 444n },
      ];
      const fee = 10n;

      const outputCommitments = await Promise.all(
        outputNotes.map((n) =>
          poseidonHash([n.owner, n.value, n.assetId, n.blinding]),
        ),
      );

      // Verify value conservation
      const totalIn = inputNotes.reduce((sum, n) => sum + n.value, 0n);
      const totalOut =
        outputNotes.reduce((sum, n) => sum + n.value, 0n) + fee;
      assert.equal(totalIn, totalOut, "Value must be conserved");

      // Build Merkle tree with both input commitments
      const { root, proofs } = await buildMerkleTree(inputCommitments, TREE_DEPTH);

      // All signals are now available for circuit witness generation
      assert.isTrue(root > 0n);
      assert.equal(nullifiers.length, 2);
      assert.equal(outputCommitments.length, 2);
      assert.equal(proofs[0].pathElements.length, TREE_DEPTH);
      assert.equal(proofs[0].pathIndices.length, TREE_DEPTH);
    });

    it("generates a complete transfer circuit witness (requires compiled circuit)", async () => {
      const wasmPath = path.join(
        BUILD_DIR,
        "transfer",
        "transfer_js",
        "transfer.wasm",
      );
      if (!fs.existsSync(wasmPath)) {
        console.log(
          "⚠ Skipping witness generation: transfer circuit not compiled",
        );
        return;
      }

      const spendingKey = 42n;
      const ownerPub = await poseidonHash([spendingKey, 0n]);
      const assetId = 1n;

      const inputNotes = [
        { owner: ownerPub, value: 500n, assetId, blinding: 111n },
        { owner: ownerPub, value: 500n, assetId, blinding: 222n },
      ];

      const inputCommitments = await Promise.all(
        inputNotes.map((n) =>
          poseidonHash([n.owner, n.value, n.assetId, n.blinding]),
        ),
      );

      const nullifiers = await Promise.all(
        inputCommitments.map((cm) => poseidonHash([spendingKey, cm])),
      );

      const recipientOwner = 88888n;
      const outputNotes = [
        { owner: recipientOwner, value: 990n, assetId, blinding: 333n },
        { owner: ownerPub, value: 0n, assetId, blinding: 444n },
      ];
      const fee = 10n;

      const outputCommitments = await Promise.all(
        outputNotes.map((n) =>
          poseidonHash([n.owner, n.value, n.assetId, n.blinding]),
        ),
      );

      const { root, proofs } = await buildMerkleTree(inputCommitments, TREE_DEPTH);

      const circuitInput = {
        merkle_root: root.toString(),
        nullifiers: nullifiers.map((n) => n.toString()),
        output_commitments: outputCommitments.map((c) => c.toString()),
        fee: fee.toString(),
        spending_key: spendingKey.toString(),
        in_owner: inputNotes.map((n) => n.owner.toString()),
        in_value: inputNotes.map((n) => n.value.toString()),
        in_asset_id: inputNotes.map((n) => n.assetId.toString()),
        in_blinding: inputNotes.map((n) => n.blinding.toString()),
        merkle_path_elements: proofs.map((p) =>
          p.pathElements.map((e) => e.toString()),
        ),
        merkle_path_indices: proofs.map((p) =>
          p.pathIndices.map((i) => i.toString()),
        ),
        out_owner: outputNotes.map((n) => n.owner.toString()),
        out_value: outputNotes.map((n) => n.value.toString()),
        out_asset_id: outputNotes.map((n) => n.assetId.toString()),
        out_blinding: outputNotes.map((n) => n.blinding.toString()),
      };

      // Generate witness via snarkjs
      const { wtns } = await import("snarkjs");
      const witness = { type: "mem" } as any;
      await wtns.calculate(circuitInput, wasmPath, witness);

      assert.isNotNull(witness, "Witness generation should succeed for valid transfer");
    });
  });

  describe("withdrawal flow (off-chain)", () => {
    it("simulates a withdrawal: 1 input → public recipient + fee", async () => {
      const spendingKey = 42n;
      const ownerPub = await poseidonHash([spendingKey, 0n]);
      const assetId = 1n;

      // Input note: 1000
      const inputNote = {
        owner: ownerPub,
        value: 1000n,
        assetId,
        blinding: 555n,
      };
      const commitment = await poseidonHash([
        inputNote.owner,
        inputNote.value,
        inputNote.assetId,
        inputNote.blinding,
      ]);

      const nullifier = await poseidonHash([spendingKey, commitment]);

      // Withdrawal: 990 to public address, 10 fee, 0 change
      const withdrawAmount = 990n;
      const fee = 10n;

      assert.equal(
        inputNote.value,
        withdrawAmount + fee,
        "Withdrawal + fee must equal input",
      );
      assert.isTrue(nullifier > 0n, "Nullifier should be non-zero");
    });
  });
});
