import { Hash32 } from "./types";

/**
 * Poseidon hash utility wrapping circomlibjs.
 *
 * Uses lazy initialization — the Poseidon function is built once on first call
 * and reused for all subsequent hashes. This matches the BN254 Poseidon used
 * in the Circom circuits (poseidon.circom).
 */

let poseidonFn: ((inputs: bigint[]) => bigint) | null = null;

async function getPoseidon(): Promise<(inputs: bigint[]) => bigint> {
  if (poseidonFn) return poseidonFn;
  // circomlibjs exports buildPoseidon which returns an async factory
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  // poseidon() returns a Uint8Array (F element). We convert to bigint via F.toObject.
  poseidonFn = (inputs: bigint[]): bigint => {
    const hash = poseidon(inputs);
    return poseidon.F.toObject(hash);
  };
  return poseidonFn;
}

/** Hash arbitrary number of field elements with Poseidon. */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const fn = await getPoseidon();
  return fn(inputs);
}

/** Poseidon hash of two field elements. */
export async function poseidonHash2(a: bigint, b: bigint): Promise<bigint> {
  return poseidonHash([a, b]);
}

/** Poseidon hash returning a 32-byte hex string. */
export async function poseidonHashHex(inputs: bigint[]): Promise<Hash32> {
  const result = await poseidonHash(inputs);
  return fieldToHex(result);
}

/** Convert a field element bigint to a 32-byte zero-padded hex string. */
export function fieldToHex(field: bigint): Hash32 {
  return field.toString(16).padStart(64, "0");
}

/** Convert a 32-byte hex string to a bigint field element. */
export function hexToField(hex: Hash32): bigint {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned === "0".repeat(64)) return 0n;
  return BigInt("0x" + cleaned);
}
