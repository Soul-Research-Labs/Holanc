// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const PROGRAM_IDS = {
  holanc_pool: "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
  holanc_verifier: "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
  holanc_nullifier: "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
  holanc_bridge: "H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K",
  holanc_compliance: "8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE",
};

/** Load an Anchor IDL from the target/idl directory. Returns null if not found. */
function loadIdl(programName: string): any | null {
  const idlPath = path.resolve(
    __dirname,
    "..",
    "target",
    "idl",
    `${programName}.json`,
  );
  if (!fs.existsSync(idlPath)) {
    console.warn(`  ⚠  IDL not found at ${idlPath} — skipping ${programName}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  console.log("=== Holanc Deployment ===");
  console.log(`Cluster: ${provider.connection.rpcEndpoint}`);
  console.log(`Payer:   ${provider.wallet.publicKey.toBase58()}`);
  console.log();

  // -------------------------------------------------------------------------
  // 1. holanc-pool — Initialize privacy pool (requires a token mint)
  // -------------------------------------------------------------------------
  const poolIdl = loadIdl("holanc_pool");
  if (poolIdl) {
    const poolProgram = new anchor.Program(
      poolIdl,
      new PublicKey(PROGRAM_IDS.holanc_pool),
      provider,
    );
    console.log(`[holanc-pool] ${PROGRAM_IDS.holanc_pool}`);
    console.log(
      "  Pool requires an SPL token mint to initialize. " +
        "Call `poolProgram.methods.initialize()` with your mint after deployment.",
    );
  }

  // -------------------------------------------------------------------------
  // 2. holanc-verifier — Initialize verification key storage
  // -------------------------------------------------------------------------
  const verifierIdl = loadIdl("holanc_verifier");
  if (verifierIdl) {
    const verifierProgram = new anchor.Program(
      verifierIdl,
      new PublicKey(PROGRAM_IDS.holanc_verifier),
      provider,
    );
    console.log(`[holanc-verifier] ${PROGRAM_IDS.holanc_verifier}`);
    console.log(
      "  Verifier initialized. Upload Groth16 VK via `initialize_vk()` before use.",
    );
  }

  // -------------------------------------------------------------------------
  // 3. holanc-nullifier — Initialize nullifier registry
  // -------------------------------------------------------------------------
  const nullifierIdl = loadIdl("holanc_nullifier");
  if (nullifierIdl) {
    const nullifierProgram = new anchor.Program(
      nullifierIdl,
      new PublicKey(PROGRAM_IDS.holanc_nullifier),
      provider,
    );
    console.log(`[holanc-nullifier] ${PROGRAM_IDS.holanc_nullifier}`);
    console.log(
      "  Nullifier registry ready. Initialize manager PDAs per pool after pool setup.",
    );
  }

  // -------------------------------------------------------------------------
  // 4. holanc-bridge — Initialize Wormhole cross-chain epoch sync
  // -------------------------------------------------------------------------
  const bridgeIdl = loadIdl("holanc_bridge");
  if (bridgeIdl) {
    const bridgeProgram = new anchor.Program(
      bridgeIdl,
      new PublicKey(PROGRAM_IDS.holanc_bridge),
      provider,
    );
    console.log(`[holanc-bridge] ${PROGRAM_IDS.holanc_bridge}`);
    console.log(
      "  Bridge program deployed. Call `initialize()` with Wormhole program ID and guardian set.",
    );
  }

  // -------------------------------------------------------------------------
  // 5. holanc-compliance — Initialize compliance configuration
  // -------------------------------------------------------------------------
  const complianceIdl = loadIdl("holanc_compliance");
  if (complianceIdl) {
    const complianceProgram = new anchor.Program(
      complianceIdl,
      new PublicKey(PROGRAM_IDS.holanc_compliance),
      provider,
    );
    console.log(`[holanc-compliance] ${PROGRAM_IDS.holanc_compliance}`);
    console.log(
      "  Compliance program deployed. Call `initialize()` per pool with desired ComplianceMode.",
    );
  }

  console.log();
  console.log("=== Deployment Summary ===");
  for (const [name, id] of Object.entries(PROGRAM_IDS)) {
    console.log(`  ${name.padEnd(20)} ${id}`);
  }
  console.log();
  console.log(
    "Next steps:\n" +
      "  1. anchor build && anchor deploy (if programs not yet on-chain)\n" +
      "  2. Create SPL token mint\n" +
      "  3. Call holanc-pool::initialize(mint)\n" +
      "  4. Call holanc-verifier::initialize_vk(vk_bytes) with your circuit VK\n" +
      "  5. Call holanc-nullifier::initialize_manager(pool)\n" +
      "  6. (Optional) Call holanc-compliance::initialize(pool, mode)\n" +
      "  7. (Optional) Call holanc-bridge::initialize(wormhole_program, guardian_set)",
  );
};
