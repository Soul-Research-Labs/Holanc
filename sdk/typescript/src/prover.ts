import { Note, Groth16Proof, Hash32, TransferV2Params } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let snarkjs: any = null;

async function loadSnarkjs() {
  if (!snarkjs) {
    snarkjs = await import(/* webpackIgnore: true */ "snarkjs");
  }
  return snarkjs;
}

interface TransferProveParams {
  spendingKey: Hash32;
  inputNotes: Note[];
  outputNotes: Note[];
  fee: bigint;
}

interface TransferV2ProveParams extends TransferProveParams {
  chainId: number;
  appId: number;
}

interface WithdrawProveParams {
  spendingKey: Hash32;
  inputNotes: Note[];
  outputNotes: Note[];
  exitValue: bigint;
  fee: bigint;
}

interface WithdrawV2ProveParams extends WithdrawProveParams {
  chainId: number;
  appId: number;
}

interface StealthTransferProveParams extends TransferProveParams {
  ephemeralKey: Hash32;
  recipientSpendingPubkey: Hash32;
}

export interface Transfer4x4ProveParams extends TransferProveParams {
  /** Boolean selectors — true for active inputs, false for padding */
  hasInput: boolean[];
  /** Boolean selectors — true for active outputs, false for padding */
  hasOutput: boolean[];
}

export interface Withdraw4x4ProveParams extends Transfer4x4ProveParams {
  exitValue: bigint;
}

interface WealthProofProveParams {
  spendingKey: Hash32;
  inputNotes: Note[];
  threshold: bigint;
}

interface ProveResult {
  proof: Groth16Proof;
  publicSignals: string[];
}

/**
 * HolancProver — wraps snarkjs for Groth16 proof generation.
 *
 * Loads WASM and zkey artifacts and generates proofs for the deposit,
 * transfer, and withdraw circuits.
 */
export class HolancProver {
  private circuitDir: string;

  constructor(circuitDir: string = "./circuits/build") {
    this.circuitDir = circuitDir;
  }

  /**
   * Generate a proof for the transfer circuit (2-in, 2-out).
   */
  async proveTransfer(params: TransferProveParams): Promise<ProveResult> {
    const input = this.buildTransferInput(params);
    return this.prove("transfer", input);
  }

  /**
   * Generate a proof for the withdraw circuit.
   */
  async proveWithdraw(params: WithdrawProveParams): Promise<ProveResult> {
    const input = this.buildWithdrawInput(params);
    return this.prove("withdraw", input);
  }

  /**
   * Generate a proof for the deposit circuit.
   */
  async proveDeposit(
    owner: Hash32,
    value: bigint,
    assetId: Hash32,
    blinding: Hash32,
  ): Promise<ProveResult> {
    const input = {
      owner: hexToBigInt(owner).toString(),
      value: value.toString(),
      asset_id: hexToBigInt(assetId).toString(),
      blinding: hexToBigInt(blinding).toString(),
    };
    return this.prove("deposit", input);
  }

  /**
   * Generate a proof for the transfer_v2 circuit (domain-separated nullifiers).
   */
  async proveTransferV2(params: TransferV2ProveParams): Promise<ProveResult> {
    const base = this.buildTransferInput(params);
    return this.prove("transfer_v2", {
      ...base,
      chain_id: params.chainId.toString(),
      app_id: params.appId.toString(),
    });
  }

  /**
   * Generate a proof for the withdraw_v2 circuit (domain-separated nullifiers).
   */
  async proveWithdrawV2(params: WithdrawV2ProveParams): Promise<ProveResult> {
    const base = this.buildWithdrawInput(params);
    return this.prove("withdraw_v2", {
      ...base,
      chain_id: params.chainId.toString(),
      app_id: params.appId.toString(),
    });
  }

  /**
   * Generate a proof for the stealth transfer circuit.
   */
  async proveStealthTransfer(
    params: StealthTransferProveParams,
  ): Promise<ProveResult> {
    const base = this.buildTransferInput(params);
    return this.prove("stealth_transfer", {
      ...base,
      ephemeral_key: hexToBigInt(params.ephemeralKey).toString(),
      recipient_spending_pubkey: hexToBigInt(
        params.recipientSpendingPubkey,
      ).toString(),
    });
  }

  /**
   * Generate a proof for the wealth proof circuit (balance >= threshold).
   */
  async proveWealth(params: WealthProofProveParams): Promise<ProveResult> {
    const inputs = padNotes(params.inputNotes, 8);
    const hasNote = inputs.map((n) => (n.value > 0n ? "1" : "0"));

    return this.prove("wealth_proof", {
      spending_key: hexToBigInt(params.spendingKey).toString(),
      note_value: inputs.map((n) => n.value.toString()),
      note_blinding: inputs.map((n) => hexToBigInt(n.blinding).toString()),
      note_asset_id: inputs.map((n) => hexToBigInt(n.assetId).toString()),
      has_note: hasNote,
      merkle_path_elements: inputs.map(() => new Array(20).fill("0")),
      merkle_path_indices: inputs.map(() => new Array(20).fill("0")),
      threshold: params.threshold.toString(),
    });
  }

  /**
   * Generate a proof for the transfer_4x4 circuit (variable 4-in, 4-out).
   */
  async proveTransfer4x4(params: Transfer4x4ProveParams): Promise<ProveResult> {
    const input = this.buildTransfer4x4Input(params);
    return this.prove("transfer_4x4", input);
  }

  /**
   * Generate a proof for the withdraw_4x4 circuit (variable 4-in, 4-out with exit).
   */
  async proveWithdraw4x4(params: Withdraw4x4ProveParams): Promise<ProveResult> {
    const base = this.buildTransfer4x4Input(params);
    return this.prove("withdraw_4x4", {
      ...base,
      exit_value: params.exitValue.toString(),
    });
  }

  /**
   * Verify a Groth16 proof locally (for testing / debugging).
   */
  async verifyLocally(
    circuitName: string,
    proof: Groth16Proof,
    publicSignals: string[],
  ): Promise<boolean> {
    const snarks = await loadSnarkjs();
    const vkeyPath = `${this.circuitDir}/${circuitName}/${circuitName}_vkey.json`;
    // In a real implementation, load vkey from file
    // For now, we rely on snarkjs verify
    const vkey = await import(vkeyPath);
    return snarks.groth16.verify(vkey, publicSignals, proof);
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private async prove(
    circuitName: string,
    input: Record<string, unknown>,
  ): Promise<ProveResult> {
    const snarks = await loadSnarkjs();
    const wasmPath = `${this.circuitDir}/${circuitName}/${circuitName}_js/${circuitName}.wasm`;
    const zkeyPath = `${this.circuitDir}/${circuitName}/${circuitName}_final.zkey`;

    const { proof, publicSignals } = await snarks.groth16.fullProve(
      input,
      wasmPath,
      zkeyPath,
    );

    return {
      proof: {
        piA: proof.pi_a.slice(0, 2) as [string, string],
        piB: proof.pi_b.slice(0, 2).map((p: string[]) => p.slice(0, 2)) as [
          [string, string],
          [string, string],
        ],
        piC: proof.pi_c.slice(0, 2) as [string, string],
        protocol: "groth16",
        curve: "bn128",
      },
      publicSignals,
    };
  }

  private buildTransferInput(
    params: TransferProveParams,
  ): Record<string, unknown> {
    const { spendingKey, inputNotes, outputNotes, fee } = params;
    // Pad to exactly 2 inputs
    const inputs = padNotes(inputNotes, 2);
    const outputs = padNotes(outputNotes, 2);

    return {
      spending_key: hexToBigInt(spendingKey).toString(),
      input_value: inputs.map((n) => n.value.toString()),
      input_blinding: inputs.map((n) => hexToBigInt(n.blinding).toString()),
      input_asset_id: inputs.map((n) => hexToBigInt(n.assetId).toString()),
      // Merkle proof placeholders — filled by caller or fetched from tree
      merkle_path_elements: inputs.map(() => new Array(20).fill("0")),
      merkle_path_indices: inputs.map(() => new Array(20).fill("0")),
      output_owner: outputs.map((n) => hexToBigInt(n.owner).toString()),
      output_value: outputs.map((n) => n.value.toString()),
      output_blinding: outputs.map((n) => hexToBigInt(n.blinding).toString()),
      output_asset_id: outputs.map((n) => hexToBigInt(n.assetId).toString()),
      fee: fee.toString(),
    };
  }

  private buildWithdrawInput(
    params: WithdrawProveParams,
  ): Record<string, unknown> {
    const base = this.buildTransferInput({
      ...params,
    });
    return {
      ...base,
      exit_value: params.exitValue.toString(),
    };
  }

  private buildTransfer4x4Input(
    params: Transfer4x4ProveParams,
  ): Record<string, unknown> {
    const { spendingKey, inputNotes, outputNotes, fee, hasInput, hasOutput } =
      params;
    const inputs = padNotes(inputNotes, 4);
    const outputs = padNotes(outputNotes, 4);
    const hasIn = (hasInput || []).concat(new Array(4).fill(false)).slice(0, 4);
    const hasOut = (hasOutput || [])
      .concat(new Array(4).fill(false))
      .slice(0, 4);

    return {
      spending_key: hexToBigInt(spendingKey).toString(),
      value: inputs.map((n) => n.value.toString()),
      blinding: inputs.map((n) => hexToBigInt(n.blinding).toString()),
      asset_id: inputs.map((n) => hexToBigInt(n.assetId).toString()),
      has_input: hasIn.map((v: boolean) => (v ? "1" : "0")),
      merkle_path_elements: inputs.map(() => new Array(20).fill("0")),
      merkle_path_indices: inputs.map(() => new Array(20).fill("0")),
      output_owner: outputs.map((n) => hexToBigInt(n.owner).toString()),
      output_value: outputs.map((n) => n.value.toString()),
      output_blinding: outputs.map((n) => hexToBigInt(n.blinding).toString()),
      output_asset_id: outputs.map((n) => hexToBigInt(n.assetId).toString()),
      has_output: hasOut.map((v: boolean) => (v ? "1" : "0")),
      fee: fee.toString(),
    };
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function hexToBigInt(hex: Hash32): bigint {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex === "0".repeat(64)) return 0n;
  return BigInt("0x" + hex);
}

/** Pad a note array to the target length with zero-value dummy notes. */
function padNotes(notes: Note[], target: number): Note[] {
  const padded = [...notes];
  while (padded.length < target) {
    padded.push({
      owner: "0".repeat(64),
      value: 0n,
      assetId: "0".repeat(64),
      blinding: "0".repeat(64),
      commitment: "0".repeat(64),
      nullifier: "0".repeat(64),
      spent: false,
    });
  }
  return padded;
}
