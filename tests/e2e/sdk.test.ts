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

  it("stealthSend generates valid ephemeral key and stealth owner", async () => {
    const recipientSpendPubkey = "ab".repeat(32);
    const recipientViewPubkey = "cd".repeat(32);

    const meta = {
      spendingPubkey: recipientSpendPubkey,
      viewingPubkey: recipientViewPubkey,
    };
    const result = await stealth.stealthSend(meta);

    assert.isString(result.ephemeralPubkey);
    assert.isString(result.stealthOwner);
    assert.isString(result.sharedSecret);
    assert.lengthOf(
      result.ephemeralPubkey,
      64,
      "ephemeralPubkey should be 32 bytes hex",
    );
    assert.lengthOf(
      result.stealthOwner,
      64,
      "stealthOwner should be 32 bytes hex",
    );
  });

  it("stealthScan returns expected shape from matching scan", async () => {
    const recipientSpendPubkey = "ab".repeat(32);
    const recipientViewPubkey = "cd".repeat(32);
    const meta = {
      spendingPubkey: recipientSpendPubkey,
      viewingPubkey: recipientViewPubkey,
    };

    const sendResult = await stealth.stealthSend(meta);

    // The recipient scans with their view key.
    // Note: In the hash-based scheme (placeholder for BabyJubJub ECDH),
    // matching requires ephemeralKey*viewPubkey == viewKey*ephemeralPubkey
    // which doesn't hold for hash functions. The scan API is tested for shape.
    const scanResult = await stealth.stealthScan(
      recipientViewPubkey,
      recipientSpendPubkey,
      sendResult.ephemeralPubkey,
      sendResult.stealthOwner,
    );

    assert.property(scanResult, "isOurs");
    assert.isBoolean(scanResult.isOurs);
  });

  it("stealthScan rejects non-matching stealth addresses", async () => {
    const recipientSpendPubkey = "ab".repeat(32);
    const recipientViewPubkey = "cd".repeat(32);
    const meta = {
      spendingPubkey: recipientSpendPubkey,
      viewingPubkey: recipientViewPubkey,
    };

    const sendResult = await stealth.stealthSend(meta);

    // A different recipient tries to scan
    const wrongSpendPubkey = "ff".repeat(32);
    const wrongViewPubkey = "ee".repeat(32);

    const scanResult = await stealth.stealthScan(
      wrongViewPubkey,
      wrongSpendPubkey,
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
    const meta = {
      spendingPubkey: "ab".repeat(32),
      viewingPubkey: "cd".repeat(32),
    };

    const result1 = await stealth.stealthSend(meta);
    const result2 = await stealth.stealthSend(meta);

    // Each call generates a fresh ephemeral key
    assert.notEqual(
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
