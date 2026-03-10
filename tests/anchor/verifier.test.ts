/**
 * Verifier program integration tests.
 *
 * Tests VK initialization and proof verification against the local validator.
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

const VERIFIER_ID = new PublicKey(
  "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
);

describe("holanc-verifier instructions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const payer = (provider.wallet as anchor.Wallet).payer;
  let verifierProgram: Program;
  let vkPda: PublicKey;
  let vkBump: number;

  const CIRCUIT_TYPE = 1; // deposit circuit

  before(async () => {
    try {
      const idl = await Program.fetchIdl(VERIFIER_ID, provider);
      if (idl) {
        verifierProgram = new Program(idl, provider);
      }
    } catch {
      // IDL not available
    }

    [vkPda, vkBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk"), Buffer.from([CIRCUIT_TYPE])],
      VERIFIER_ID,
    );
  });

  describe("initialize_vk", () => {
    it("initializes a verification key for a circuit type", async () => {
      if (!verifierProgram) {
        console.log(
          "⚠ Skipping: verifier IDL not available (run anchor build first)",
        );
        return;
      }

      // Mock VK data (valid sizes but dummy values)
      const vkAlphaG1 = Buffer.alloc(64);
      vkAlphaG1[0] = 0x01;
      const vkBetaG2 = Buffer.alloc(128);
      vkBetaG2[0] = 0x02;
      const vkGammaG2 = Buffer.alloc(128);
      vkGammaG2[0] = 0x03;
      const vkDeltaG2 = Buffer.alloc(128);
      vkDeltaG2[0] = 0x04;

      // IC points — need at least 1 for the verifier
      const ic: number[][] = [];
      for (let i = 0; i < 3; i++) {
        const point = Array(64).fill(0);
        point[0] = i + 1;
        ic.push(point);
      }

      await verifierProgram.methods
        .initializeVk(
          CIRCUIT_TYPE,
          [...vkAlphaG1],
          [...vkBetaG2],
          [...vkGammaG2],
          [...vkDeltaG2],
          ic,
        )
        .accounts({
          verificationKey: vkPda,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vkAccount = await verifierProgram.account.verificationKey.fetch(
        vkPda,
      );
      assert.equal(vkAccount.circuitType, CIRCUIT_TYPE);
      assert.equal(vkAccount.authority.toBase58(), payer.publicKey.toBase58());
      assert.equal(vkAccount.icLen, 3);
    });

    it("rejects more than MAX_PUBLIC_INPUTS + 1 IC points", async () => {
      if (!verifierProgram) return;

      const [vkPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vk"), Buffer.from([99])],
        VERIFIER_ID,
      );

      // 10 IC points exceed MAX_PUBLIC_INPUTS (8) + 1 = 9
      const ic: number[][] = [];
      for (let i = 0; i < 10; i++) {
        ic.push(Array(64).fill(i));
      }

      try {
        await verifierProgram.methods
          .initializeVk(
            99,
            Array(64).fill(0),
            Array(128).fill(0),
            Array(128).fill(0),
            Array(128).fill(0),
            ic,
          )
          .accounts({
            verificationKey: vkPda2,
            authority: payer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown TooManyIcPoints");
      } catch (err: any) {
        assert.include(err.toString(), "TooManyIcPoints");
      }
    });
  });

  describe("verify_proof", () => {
    it("rejects invalid proof against stored VK", async () => {
      if (!verifierProgram) {
        console.log("⚠ Skipping: verifier IDL not available");
        return;
      }

      // Invalid proof data — all zeros will fail BN128 operations
      const proofA = Buffer.alloc(64);
      const proofB = Buffer.alloc(128);
      const proofC = Buffer.alloc(64);
      const publicInputs: number[][] = [Array(32).fill(0), Array(32).fill(0)];

      try {
        await verifierProgram.methods
          .verifyProof([...proofA], [...proofB], [...proofC], publicInputs)
          .accounts({
            verificationKey: vkPda,
            authority: payer.publicKey,
          })
          .rpc();
        assert.fail("Should have thrown verification error");
      } catch (err: any) {
        // Should fail with a BN128 syscall or verification error
        const errStr = err.toString();
        const isExpectedError =
          errStr.includes("Bn128") ||
          errStr.includes("ProofVerificationFailed") ||
          errStr.includes("PublicInputCountMismatch") ||
          errStr.includes("custom program error");
        assert.isTrue(isExpectedError, `Unexpected error: ${errStr}`);
      }
    });
  });
});
