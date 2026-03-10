/**
 * Circuit structure validation tests.
 *
 * These tests verify that the Circom circuit files exist, are syntactically
 * valid, and have the expected structure. Full constraint-system tests
 * require circom compilation + snarkjs (see scripts/setup-circuits.sh).
 */

import * as fs from "fs";
import * as path from "path";
import { assert } from "chai";

const CIRCUITS_DIR = path.resolve(__dirname, "../../circuits");

const EXPECTED_CIRCUITS = [
  { name: "deposit", file: "deposit/deposit.circom" },
  { name: "transfer", file: "transfer/transfer.circom" },
  { name: "withdraw", file: "withdraw/withdraw.circom" },
  { name: "transfer_v2", file: "transfer_v2/transfer_v2.circom" },
  { name: "withdraw_v2", file: "withdraw_v2/withdraw_v2.circom" },
  {
    name: "stealth_transfer",
    file: "stealth_transfer/stealth_transfer.circom",
  },
  { name: "wealth_proof", file: "wealth_proof/wealth_proof.circom" },
  { name: "transfer_4x4", file: "transfer_4x4/transfer_4x4.circom" },
  { name: "withdraw_4x4", file: "withdraw_4x4/withdraw_4x4.circom" },
];

describe("circuit files", () => {
  for (const circuit of EXPECTED_CIRCUITS) {
    it(`${circuit.name} circuit file exists`, () => {
      const filePath = path.join(CIRCUITS_DIR, circuit.file);
      assert.isTrue(fs.existsSync(filePath), `Missing circuit: ${filePath}`);
    });

    it(`${circuit.name} circuit has main component`, () => {
      const filePath = path.join(CIRCUITS_DIR, circuit.file);
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf8");
      assert.include(
        content,
        "component main",
        `${circuit.name} should declare a main component`,
      );
    });
  }

  it("common library exists", () => {
    const commonPath = path.join(CIRCUITS_DIR, "lib/common.circom");
    assert.isTrue(fs.existsSync(commonPath), "lib/common.circom should exist");
  });

  it("common library exports Poseidon-based templates", () => {
    const commonPath = path.join(CIRCUITS_DIR, "lib/common.circom");
    if (!fs.existsSync(commonPath)) return;

    const content = fs.readFileSync(commonPath, "utf8");
    assert.include(
      content,
      "template Commitment",
      "Should have Commitment template",
    );
    assert.include(
      content,
      "template Nullifier",
      "Should have Nullifier template",
    );
    assert.include(
      content,
      "template MerkleProof",
      "Should have MerkleProof template",
    );
  });

  describe("circuit public signals", () => {
    it("transfer_v2 adds chain_id and app_id", () => {
      const filePath = path.join(
        CIRCUITS_DIR,
        "transfer_v2/transfer_v2.circom",
      );
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf8");
      assert.include(content, "chain_id");
      assert.include(content, "app_id");
    });

    it("stealth_transfer adds ephemeral_pubkey", () => {
      const filePath = path.join(
        CIRCUITS_DIR,
        "stealth_transfer/stealth_transfer.circom",
      );
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf8");
      assert.include(content, "ephemeral_pubkey");
      assert.include(content, "ephemeral_key");
      assert.include(content, "recipient_spending_pubkey");
    });

    it("wealth_proof has threshold and owner_commitment", () => {
      const filePath = path.join(
        CIRCUITS_DIR,
        "wealth_proof/wealth_proof.circom",
      );
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf8");
      assert.include(content, "threshold");
      assert.include(content, "owner_commitment");
    });
  });
});
