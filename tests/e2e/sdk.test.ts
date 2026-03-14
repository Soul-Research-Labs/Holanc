/**
 * End-to-end test for the Holanc privacy protocol flow.
 *
 * Tests the SDK's stealth address, bridge, and compliance modules
 * in isolation (without a running validator — unit-style e2e).
 */

import { assert } from "chai";

// --------------------------------------------------------------------------
// Stealth address tests
// --------------------------------------------------------------------------

describe("stealth addresses", () => {
  // Dynamic import since modules may not be built yet in CI
  let stealth: typeof import("../../sdk/typescript/src/stealth");

  before(async () => {
    stealth = await import("../../sdk/typescript/src/stealth");
  });

  it("generates a BabyJubJub keypair for stealth meta-address", async () => {
    const { secretKey, publicKey } = await stealth.generateBjjKeypair();
    assert.lengthOf(secretKey, 64, "Secret key should be 32 bytes hex");
    assert.lengthOf(publicKey[0], 64, "Public key x should be 32 bytes hex");
    assert.lengthOf(publicKey[1], 64, "Public key y should be 32 bytes hex");
  });

  it("stealthSend generates valid ephemeral pubkey point and stealth owner", async () => {
    const { secretKey, publicKey: viewingPubkey } =
      await stealth.generateBjjKeypair();
    const spendingPubkey = "ab".repeat(32);

    const meta = { spendingPubkey, viewingPubkey };
    const result = await stealth.stealthSend(meta);

    assert.isArray(result.ephemeralPubkey);
    assert.lengthOf(result.ephemeralPubkey, 2, "Ephemeral pubkey should be [x, y]");
    assert.isString(result.stealthOwner);
    assert.isString(result.sharedSecret);
    assert.lengthOf(result.stealthOwner, 64, "stealthOwner should be 32 bytes hex");
  });

  it("stealthScan correctly identifies own notes via ECDH", async () => {
    const { secretKey: viewingKey, publicKey: viewingPubkey } =
      await stealth.generateBjjKeypair();
    const spendingPubkey = "ab".repeat(32);

    const meta = { spendingPubkey, viewingPubkey };
    const sendResult = await stealth.stealthSend(meta);

    // Recipient scans with their viewing key — ECDH commutativity ensures match
    const scanResult = await stealth.stealthScan(
      viewingKey,
      spendingPubkey,
      sendResult.ephemeralPubkey,
      sendResult.stealthOwner,
    );

    assert.isTrue(scanResult.isOurs, "Recipient should find their own note via ECDH");
    assert.equal(scanResult.sharedSecret, sendResult.sharedSecret,
      "Shared secrets should match via ECDH commutativity");
  });

  it("stealthScan rejects non-matching stealth addresses", async () => {
    const { secretKey: viewingKey, publicKey: viewingPubkey } =
      await stealth.generateBjjKeypair();
    const spendingPubkey = "ab".repeat(32);

    const meta = { spendingPubkey, viewingPubkey };
    const sendResult = await stealth.stealthSend(meta);

    // A different recipient with different keys tries to scan
    const { secretKey: wrongViewingKey } = await stealth.generateBjjKeypair();

    const scanResult = await stealth.stealthScan(
      wrongViewingKey,
      spendingPubkey,
      sendResult.ephemeralPubkey,
      sendResult.stealthOwner,
    );

    assert.isFalse(scanResult.isOurs, "Wrong recipient should not match");
  });

  it("deriveStealthSpendingKey produces deterministic output", async () => {
    const spendingKey = "ab".repeat(32);
    const sharedSecret = "cd".repeat(32);

    const key1 = await stealth.deriveStealthSpendingKey(
      spendingKey,
      sharedSecret,
    );
    const key2 = await stealth.deriveStealthSpendingKey(
      spendingKey,
      sharedSecret,
    );

    assert.equal(key1, key2, "Same inputs should produce same spending key");
    assert.lengthOf(key1, 64, "Spending key should be 32 bytes hex");
  });

  it("different ephemeral keys produce different stealth owners", async () => {
    const { publicKey: viewingPubkey } = await stealth.generateBjjKeypair();
    const meta = {
      spendingPubkey: "ab".repeat(32),
      viewingPubkey,
    };

    const result1 = await stealth.stealthSend(meta);
    const result2 = await stealth.stealthSend(meta);

    // Each call generates a fresh ephemeral key
    assert.notDeepEqual(
      result1.ephemeralPubkey,
      result2.ephemeralPubkey,
      "Ephemeral keys should differ",
    );
    assert.notEqual(
      result1.stealthOwner,
      result2.stealthOwner,
      "Stealth owners should differ",
    );
  });
});

// --------------------------------------------------------------------------
// Bridge SDK tests
// --------------------------------------------------------------------------

describe("bridge SDK", () => {
  let bridge: typeof import("../../sdk/typescript/src/bridge");
  let PublicKey: typeof import("@solana/web3.js").PublicKey;

  before(async () => {
    bridge = await import("../../sdk/typescript/src/bridge");
    const web3 = await import("@solana/web3.js");
    PublicKey = web3.PublicKey;
  });

  it("SvmChain has correct discriminants", () => {
    assert.equal(bridge.SvmChain.Solana, 1);
    assert.equal(bridge.SvmChain.Eclipse, 2);
    assert.equal(bridge.SvmChain.Sonic, 3);
  });

  it("getBridgePda is deterministic", () => {
    const conn = null as any; // PDA derivation is offline
    const b = new bridge.HolancBridge(conn);
    const pool = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");

    const pda1 = b.getBridgePda(pool);
    const pda2 = b.getBridgePda(pool);

    assert.equal(pda1.toBase58(), pda2.toBase58());
  });

  it("getForeignRootPda varies by chain and epoch", () => {
    const conn = null as any;
    const b = new bridge.HolancBridge(conn);
    const pool = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");

    const pda_solana_0 = b.getForeignRootPda(pool, bridge.SvmChain.Solana, 0);
    const pda_eclipse_0 = b.getForeignRootPda(pool, bridge.SvmChain.Eclipse, 0);
    const pda_solana_1 = b.getForeignRootPda(pool, bridge.SvmChain.Solana, 1);

    assert.notEqual(pda_solana_0.toBase58(), pda_eclipse_0.toBase58());
    assert.notEqual(pda_solana_0.toBase58(), pda_solana_1.toBase58());
  });
});

// --------------------------------------------------------------------------
// Compliance SDK tests
// --------------------------------------------------------------------------

describe("compliance SDK", () => {
  let compliance: typeof import("../../sdk/typescript/src/compliance");
  let PublicKey: typeof import("@solana/web3.js").PublicKey;

  before(async () => {
    compliance = await import("../../sdk/typescript/src/compliance");
    const web3 = await import("@solana/web3.js");
    PublicKey = web3.PublicKey;
  });

  it("ComplianceMode has correct discriminants", () => {
    assert.equal(compliance.ComplianceMode.Permissionless, 0);
    assert.equal(compliance.ComplianceMode.OptionalDisclosure, 1);
    assert.equal(compliance.ComplianceMode.MandatoryDisclosure, 2);
  });

  it("DisclosureScope has correct discriminants", () => {
    assert.equal(compliance.DisclosureScope.Full, 0);
    assert.equal(compliance.DisclosureScope.TimeBounded, 1);
    assert.equal(compliance.DisclosureScope.AmountBounded, 2);
  });

  it("OraclePermissions are powers of 2", () => {
    assert.equal(compliance.OraclePermissions.ViewBalance, 1);
    assert.equal(compliance.OraclePermissions.ViewTransactions, 2);
    assert.equal(compliance.OraclePermissions.ViewIdentity, 4);
    assert.equal(compliance.OraclePermissions.AttestWealth, 8);
    assert.equal(compliance.OraclePermissions.Freeze, 16);
  });

  it("PDA derivation is deterministic", () => {
    const conn = null as any;
    const c = new compliance.HolancCompliance(conn);
    const pool = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");
    const oracle = new PublicKey(
      "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
    );

    const pda1 = c.getOraclePda(pool, oracle);
    const pda2 = c.getOraclePda(pool, oracle);

    assert.equal(pda1.toBase58(), pda2.toBase58());
  });

  it("different oracles produce different PDAs", () => {
    const conn = null as any;
    const c = new compliance.HolancCompliance(conn);
    const pool = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");
    const oracle1 = new PublicKey(
      "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
    );
    const oracle2 = new PublicKey(
      "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
    );

    const pda1 = c.getOraclePda(pool, oracle1);
    const pda2 = c.getOraclePda(pool, oracle2);

    assert.notEqual(pda1.toBase58(), pda2.toBase58());
  });
});
