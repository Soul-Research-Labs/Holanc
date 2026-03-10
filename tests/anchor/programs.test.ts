import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

/**
 * Integration tests for all five Holanc on-chain programs.
 *
 * Requires `anchor test` with a running local validator.
 */

const POOL_ID = new PublicKey("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");
const VERIFIER_ID = new PublicKey(
  "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
);
const NULLIFIER_ID = new PublicKey(
  "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
);
const BRIDGE_ID = new PublicKey("H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K");
const COMPLIANCE_ID = new PublicKey(
  "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
);

describe("holanc programs", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  describe("program deployment", () => {
    it("all five programs are deployed", async () => {
      const ids = [
        POOL_ID,
        VERIFIER_ID,
        NULLIFIER_ID,
        BRIDGE_ID,
        COMPLIANCE_ID,
      ];
      const names = ["pool", "verifier", "nullifier", "bridge", "compliance"];

      for (let i = 0; i < ids.length; i++) {
        const info = await provider.connection.getAccountInfo(ids[i]);
        assert.isNotNull(info, `${names[i]} program not found at ${ids[i]}`);
      }
    });
  });
});
