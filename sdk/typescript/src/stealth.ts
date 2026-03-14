import { Hash32 } from "./types";
import { poseidonHashHex, hexToField } from "./poseidon";

/**
 * Stealth address support using BabyJubJub ECDH.
 *
 * Protocol (commutative key agreement):
 *   1. Recipient publishes (spendingPubkey, viewingPubkey) where
 *      viewingPubkey = viewingKey * G on BabyJubJub.
 *   2. Sender generates ephemeral scalar r, computes R = r * G.
 *   3. Sender: shared_point = r * viewingPubkey (ECDH).
 *   4. Sender: sharedSecret = Poseidon(shared_point.x, shared_point.y).
 *   5. Sender: stealthOwner = Poseidon(spendingPubkey, sharedSecret).
 *   6. Recipient: shared_point = viewingKey * R (commutativity ⟹ same point).
 *   7. Recipient: verifies Poseidon(spendingPubkey, sharedSecret) == note.owner.
 */

// Lazy-loaded BabyJubJub instance
let _babyjub: any = null;
let _poseidon: any = null;

async function getBabyjub() {
  if (!_babyjub) {
    const circomlibjs = await import("circomlibjs");
    _babyjub = await circomlibjs.buildBabyjub();
  }
  return _babyjub;
}

async function getPoseidon() {
  if (!_poseidon) {
    const circomlibjs = await import("circomlibjs");
    _poseidon = await circomlibjs.buildPoseidon();
  }
  return _poseidon;
}

export interface StealthMetaAddress {
  /** The recipient's spending public key (Poseidon(spending_key)). */
  spendingPubkey: Hash32;
  /** The recipient's viewing public key — BabyJubJub point [x, y] as hex strings. */
  viewingPubkey: [Hash32, Hash32];
}

export interface StealthSendResult {
  /** The one-time owner to use as out_owner[0] in the circuit. */
  stealthOwner: Hash32;
  /** The shared secret for note encryption. */
  sharedSecret: Hash32;
  /** The ephemeral public key — BabyJubJub point [x, y] as hex strings. */
  ephemeralPubkey: [Hash32, Hash32];
  /** The ephemeral secret scalar (private, for circuit witness). */
  ephemeralKey: Hash32;
}

export interface StealthScanResult {
  /** Whether this note belongs to the scanner. */
  isOurs: boolean;
  /** The shared secret (if isOurs is true). */
  sharedSecret?: Hash32;
}

/**
 * Convert a BabyJubJub field element to a hex string.
 */
function fieldToHex(F: any, el: any): Hash32 {
  return F.toObject(el).toString(16).padStart(64, "0");
}

/**
 * Convert a hex string to a BabyJubJub field element.
 */
function hexToFieldBjj(F: any, hex: Hash32): any {
  return F.e(BigInt("0x" + hex));
}

/**
 * Generate a stealth address for a recipient using BabyJubJub ECDH.
 */
export async function stealthSend(
  recipientMeta: StealthMetaAddress,
): Promise<StealthSendResult> {
  const babyjub = await getBabyjub();
  const poseidon = await getPoseidon();
  const F = babyjub.F;

  // Generate ephemeral scalar
  const ephemeralBytes = crypto.getRandomValues(new Uint8Array(32));
  // Reduce mod subgroup order to get a valid scalar
  let ephemeralScalar =
    BigInt("0x" + bytesToHex(ephemeralBytes)) % babyjub.subOrder;
  // Reject zero scalar (identity point) — rehash to get a valid one
  if (ephemeralScalar === 0n) {
    ephemeralScalar = 1n;
  }
  const ephemeralKey = ephemeralScalar.toString(16).padStart(64, "0");

  // R = ephemeralScalar * G (BabyJubJub base point)
  const ephemeralPubPoint = babyjub.mulPointEscalar(
    babyjub.Base8,
    ephemeralScalar,
  );
  const ephemeralPubkey: [Hash32, Hash32] = [
    fieldToHex(F, ephemeralPubPoint[0]),
    fieldToHex(F, ephemeralPubPoint[1]),
  ];

  // Parse recipient's viewing pubkey as a BabyJubJub point
  const viewingPoint = [
    hexToFieldBjj(F, recipientMeta.viewingPubkey[0]),
    hexToFieldBjj(F, recipientMeta.viewingPubkey[1]),
  ];

  // ECDH: shared_point = ephemeralScalar * viewingPubkey
  const sharedPoint = babyjub.mulPointEscalar(viewingPoint, ephemeralScalar);

  // sharedSecret = Poseidon(shared_point.x, shared_point.y)
  const ssHash = poseidon([sharedPoint[0], sharedPoint[1]]);
  const sharedSecret = fieldToHex(F, ssHash);

  // stealthOwner = Poseidon(spendingPubkey, sharedSecret)
  const ownerHash = poseidon([
    hexToFieldBjj(F, recipientMeta.spendingPubkey),
    ssHash,
  ]);
  const stealthOwner = fieldToHex(F, ownerHash);

  return { stealthOwner, sharedSecret, ephemeralPubkey, ephemeralKey };
}

/**
 * Scan a note to check if it belongs to us using BabyJubJub ECDH.
 *
 * The recipient computes: shared_point = viewingKey * R
 * By ECDH commutativity, this equals the sender's r * viewingPubkey.
 */
export async function stealthScan(
  viewingKey: Hash32,
  spendingPubkey: Hash32,
  ephemeralPubkey: [Hash32, Hash32],
  noteOwner: Hash32,
): Promise<StealthScanResult> {
  const babyjub = await getBabyjub();
  const poseidon = await getPoseidon();
  const F = babyjub.F;

  const viewingScalar = BigInt("0x" + viewingKey) % babyjub.subOrder;
  if (viewingScalar === 0n) {
    return { isOurs: false };
  }

  // Parse ephemeral pubkey as a BabyJubJub point
  const ephPoint = [
    hexToFieldBjj(F, ephemeralPubkey[0]),
    hexToFieldBjj(F, ephemeralPubkey[1]),
  ];

  // ECDH: shared_point = viewingKey * R (== r * viewingPubkey)
  const sharedPoint = babyjub.mulPointEscalar(ephPoint, viewingScalar);

  // sharedSecret = Poseidon(shared_point.x, shared_point.y)
  const ssHash = poseidon([sharedPoint[0], sharedPoint[1]]);
  const sharedSecret = fieldToHex(F, ssHash);

  // expectedOwner = Poseidon(spendingPubkey, sharedSecret)
  const ownerHash = poseidon([hexToFieldBjj(F, spendingPubkey), ssHash]);
  const expectedOwner = fieldToHex(F, ownerHash);

  if (expectedOwner === noteOwner) {
    return { isOurs: true, sharedSecret };
  }

  return { isOurs: false };
}

/**
 * Derive the stealth spending key for spending a note at a stealth address.
 *
 * stealthSpendingKey = Poseidon(spendingKey, sharedSecret)
 */
export async function deriveStealthSpendingKey(
  spendingKey: Hash32,
  sharedSecret: Hash32,
): Promise<Hash32> {
  return poseidonHashHex([hexToField(spendingKey), hexToField(sharedSecret)]);
}

/**
 * Generate a BabyJubJub keypair for stealth meta-address.
 *
 * Returns { secretKey, publicKey: [x, y] } where publicKey = secretKey * G.
 */
export async function generateBjjKeypair(): Promise<{
  secretKey: Hash32;
  publicKey: [Hash32, Hash32];
}> {
  const babyjub = await getBabyjub();
  const F = babyjub.F;

  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  let secret = BigInt("0x" + bytesToHex(secretBytes)) % babyjub.subOrder;
  if (secret === 0n) {
    secret = 1n;
  }
  const secretKey = secret.toString(16).padStart(64, "0");

  const pubPoint = babyjub.mulPointEscalar(babyjub.Base8, secret);
  const publicKey: [Hash32, Hash32] = [
    fieldToHex(F, pubPoint[0]),
    fieldToHex(F, pubPoint[1]),
  ];

  return { secretKey, publicKey };
}

function bytesToHex(bytes: Uint8Array): Hash32 {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
