/**
 * Compliance program integration tests.
 *
 * Tests oracle registration, viewing key disclosure/revocation,
 * wealth proof submission/invalidation, and access control.
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

const COMPLIANCE_ID = new PublicKey(
  "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
);

describe("holanc-compliance instructions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  let complianceProgram: Program;
  let compliancePda: PublicKey;
  let complianceBump: number;

  const mockPool = Keypair.generate();
  const oracleKeypair = Keypair.generate();

  before(async () => {
    try {
      const idl = await Program.fetchIdl(COMPLIANCE_ID, provider);
      if (idl) {
        complianceProgram = new Program(idl, provider);
      }
    } catch {
      // IDL not available
    }

    [compliancePda, complianceBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("compliance"), mockPool.publicKey.toBuffer()],
      COMPLIANCE_ID,
    );

    // Fund oracle for signing
    const sig = await provider.connection.requestAirdrop(
      oracleKeypair.publicKey,
      LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig);
  });

  describe("initialize", () => {
    it("initializes compliance config in OptionalDisclosure mode", async () => {
      if (!complianceProgram) {
        console.log(
          "⚠ Skipping: compliance IDL not available (run anchor build first)",
        );
        return;
      }

      // ComplianceMode::OptionalDisclosure
      await complianceProgram.methods
        .initialize({ optionalDisclosure: {} })
        .accounts({
          complianceConfig: compliancePda,
          pool: mockPool.publicKey,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await complianceProgram.account.complianceConfig.fetch(
        compliancePda,
      );
      assert.equal(config.authority.toBase58(), payer.publicKey.toBase58());
      assert.equal(config.pool.toBase58(), mockPool.publicKey.toBase58());
      assert.equal(config.oracleCount, 0);
      assert.isTrue(config.isActive);
    });
  });

  describe("register_oracle", () => {
    let oracleRecordPda: PublicKey;

    before(() => {
      [oracleRecordPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("oracle"),
          mockPool.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );
    });

    it("registers an oracle with permissions", async () => {
      if (!complianceProgram) return;

      const oracleName = Buffer.alloc(32);
      Buffer.from("TestOracle").copy(oracleName);

      const permissions = {
        canView: true,
        canRequestWealthProof: true,
        canFlag: false,
      };

      await complianceProgram.methods
        .registerOracle(oracleKeypair.publicKey, [...oracleName], permissions)
        .accounts({
          complianceConfig: compliancePda,
          oracleRecord: oracleRecordPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await complianceProgram.account.oracleRecord.fetch(
        oracleRecordPda,
      );
      assert.equal(
        record.oraclePubkey.toBase58(),
        oracleKeypair.publicKey.toBase58(),
      );
      assert.isTrue(record.isActive);
      assert.isTrue(record.permissions.canView);
      assert.isTrue(record.permissions.canRequestWealthProof);
      assert.isFalse(record.permissions.canFlag);

      const config = await complianceProgram.account.complianceConfig.fetch(
        compliancePda,
      );
      assert.equal(config.oracleCount, 1);
    });
  });

  describe("disclose_viewing_key", () => {
    let disclosurePda: PublicKey;
    let oracleRecordPda: PublicKey;

    before(() => {
      [oracleRecordPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("oracle"),
          mockPool.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      [disclosurePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("disclosure"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );
    });

    it("discloses an encrypted viewing key to an oracle", async () => {
      if (!complianceProgram) return;

      const encryptedKey = Buffer.from("encrypted_viewing_key_payload_here");

      // DisclosureScope::Full
      await complianceProgram.methods
        .discloseViewingKey(encryptedKey, { full: {} })
        .accounts({
          complianceConfig: compliancePda,
          oracleRecord: oracleRecordPda,
          disclosureRecord: disclosurePda,
          discloser: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await complianceProgram.account.disclosureRecord.fetch(
        disclosurePda,
      );
      assert.equal(record.discloser.toBase58(), payer.publicKey.toBase58());
      assert.equal(
        record.oracle.toBase58(),
        oracleKeypair.publicKey.toBase58(),
      );
      assert.isFalse(record.isRevoked);
      assert.deepEqual(Buffer.from(record.encryptedViewingKey), encryptedKey);
    });
  });

  describe("revoke_disclosure", () => {
    it("revokes a previously made disclosure", async () => {
      if (!complianceProgram) return;

      const [disclosurePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("disclosure"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      await complianceProgram.methods
        .revokeDisclosure()
        .accounts({
          disclosureRecord: disclosurePda,
          discloser: payer.publicKey,
        })
        .rpc();

      const record = await complianceProgram.account.disclosureRecord.fetch(
        disclosurePda,
      );
      assert.isTrue(record.isRevoked);
      assert.isNotNull(record.revokedAt);
    });

    it("rejects double revocation", async () => {
      if (!complianceProgram) return;

      const [disclosurePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("disclosure"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      try {
        await complianceProgram.methods
          .revokeDisclosure()
          .accounts({
            disclosureRecord: disclosurePda,
            discloser: payer.publicKey,
          })
          .rpc();
        assert.fail("Should have thrown AlreadyRevoked");
      } catch (err: any) {
        assert.include(err.toString(), "AlreadyRevoked");
      }
    });

    it("rejects revocation by non-discloser", async () => {
      // First create a new disclosure to test against
      if (!complianceProgram) return;

      // Use the oracle keypair as a fake non-discloser
      const [disclosurePda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("disclosure"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      try {
        await complianceProgram.methods
          .revokeDisclosure()
          .accounts({
            disclosureRecord: disclosurePda,
            discloser: oracleKeypair.publicKey,
          })
          .signers([oracleKeypair])
          .rpc();
        assert.fail("Should have thrown NotDiscloser");
      } catch (err: any) {
        // The constraint or error should prevent this
        const errStr = err.toString();
        const isExpected =
          errStr.includes("NotDiscloser") ||
          errStr.includes("ConstraintHasOne") ||
          errStr.includes("A has one constraint");
        assert.isTrue(isExpected, `Unexpected error: ${errStr}`);
      }
    });
  });

  describe("submit_wealth_proof", () => {
    let wealthPda: PublicKey;

    before(() => {
      [wealthPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("wealth"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );
    });

    it("submits a wealth proof attestation", async () => {
      if (!complianceProgram) return;

      const threshold = new BN(1_000_000_000); // 1 token minimum
      const proofData = Buffer.from("zk_wealth_proof_blob");
      const circuitType = 7; // wealth_proof circuit

      await complianceProgram.methods
        .submitWealthProof(threshold, proofData, circuitType)
        .accounts({
          complianceConfig: compliancePda,
          wealthAttestation: wealthPda,
          prover: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const attestation =
        await complianceProgram.account.wealthAttestation.fetch(wealthPda);
      assert.equal(attestation.prover.toBase58(), payer.publicKey.toBase58());
      assert.equal(attestation.threshold.toNumber(), 1_000_000_000);
      assert.equal(attestation.circuitType, circuitType);
      assert.isTrue(attestation.isValid);
    });
  });

  describe("invalidate_wealth_proof", () => {
    it("authority invalidates a wealth proof", async () => {
      if (!complianceProgram) return;

      const [wealthPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("wealth"),
          mockPool.publicKey.toBuffer(),
          payer.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      await complianceProgram.methods
        .invalidateWealthProof()
        .accounts({
          complianceConfig: compliancePda,
          wealthAttestation: wealthPda,
          authority: payer.publicKey,
        })
        .rpc();

      const attestation =
        await complianceProgram.account.wealthAttestation.fetch(wealthPda);
      assert.isFalse(attestation.isValid);
    });
  });

  describe("deactivate_oracle", () => {
    it("deactivates an oracle", async () => {
      if (!complianceProgram) return;

      const [oracleRecordPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("oracle"),
          mockPool.publicKey.toBuffer(),
          oracleKeypair.publicKey.toBuffer(),
        ],
        COMPLIANCE_ID,
      );

      await complianceProgram.methods
        .deactivateOracle()
        .accounts({
          complianceConfig: compliancePda,
          oracleRecord: oracleRecordPda,
          authority: payer.publicKey,
        })
        .rpc();

      const record = await complianceProgram.account.oracleRecord.fetch(
        oracleRecordPda,
      );
      assert.isFalse(record.isActive);
    });
  });
});
