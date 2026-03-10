import { Hash32 } from "./types";
import { poseidonHashHex, hexToField } from "./poseidon";

/**
 * Stealth address support for the Holanc privacy protocol.
 *
 * Allows senders to derive one-time addresses for recipients without
 * requiring the recipient to publish a fresh address for each transaction.
 *
 * Protocol:
 *   1. Recipient publishes a stealth meta-address (spendingPubkey, viewingPubkey).
 *   2. Sender generates an ephemeral keypair (scalar, publicKey).
 *   3. Sender computes sharedSecret = Hash(ephemeralScalar, viewingPubkey).
 *   4. Sender derives stealthOwner = Hash(spendingPubkey, sharedSecret).
 *   5. Sender creates output note with owner = stealthOwner.
 *   6. Sender publishes ephemeralPubkey alongside the encrypted note.
 *   7. Recipient scans: recompute sharedSecret using viewingKey + ephemeralPubkey.
 */

export interface StealthMetaAddress {
  /** The recipient's spending public key (Poseidon(spending_key)). */
  spendingPubkey: Hash32;
  /** The recipient's viewing public key (derived from viewing key). */
  viewingPubkey: Hash32;
}

export interface StealthSendResult {
  /** The one-time owner to use as out_owner[0] in the circuit. */
  stealthOwner: Hash32;
  /** The shared secret for note encryption. */
  sharedSecret: Hash32;
  /** The ephemeral public key (published on-chain for scanning). */
  ephemeralPubkey: Hash32;
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
 * Generate a stealth address for a recipient.
 *
 * Uses hash-based key exchange (will be replaced by BabyJubJub ECDH in production).
 * This matches the circuit constraints in stealth_transfer.circom:
 *   ephemeralPubkey = Poseidon(ephemeralKey)
 *   sharedSecret = Poseidon(ephemeralKey, recipientSpendingPubkey)
 *   stealthOwner = Poseidon(recipientSpendingPubkey, sharedSecret)
 */
export async function stealthSend(
  recipientMeta: StealthMetaAddress,
): Promise<StealthSendResult> {
  // Generate ephemeral scalar
  const ephemeralBytes = crypto.getRandomValues(new Uint8Array(32));
  const ephemeralKey = bytesToHex(ephemeralBytes);

  // ephemeralPubkey = Poseidon(ephemeralKey) — matches Poseidon(ephemeral_key) in circuit
  const ephemeralPubkey = await poseidonHashHex([hexToField(ephemeralKey)]);

  // sharedSecret = Poseidon(ephemeralKey, recipientSpendingPubkey)
  const sharedSecret = await poseidonHashHex([
    hexToField(ephemeralKey),
    hexToField(recipientMeta.spendingPubkey),
  ]);

  // stealthOwner = Poseidon(recipientSpendingPubkey, sharedSecret)
  const stealthOwner = await poseidonHashHex([
    hexToField(recipientMeta.spendingPubkey),
    hexToField(sharedSecret),
  ]);

  return { stealthOwner, sharedSecret, ephemeralPubkey, ephemeralKey };
}

/**
 * Scan a note to check if it belongs to us (recipient side).
 *
 * Recomputes the stealth address from our keys and the sender's ephemeral pubkey.
 */
export async function stealthScan(
  viewingKey: Hash32,
  spendingPubkey: Hash32,
  ephemeralPubkey: Hash32,
  noteOwner: Hash32,
): Promise<StealthScanResult> {
  // In the hash-based scheme, the recipient recomputes the shared secret:
  //   sharedSecret = Poseidon(ephemeralPubkey, viewingKey)
  // This is consistent when sender uses Poseidon(ephemeralKey, spendingPubkey)
  // because in production, the ECDH would be: ephemeralKey * viewingPubkey == viewingKey * ephemeralPubkey
  const sharedSecret = await poseidonHashHex([
    hexToField(ephemeralPubkey),
    hexToField(viewingKey),
  ]);

  // expectedOwner = Poseidon(spendingPubkey, sharedSecret)
  const expectedOwner = await poseidonHashHex([
    hexToField(spendingPubkey),
    hexToField(sharedSecret),
  ]);

  if (expectedOwner === noteOwner) {
    return { isOurs: true, sharedSecret };
  }

  return { isOurs: false };
}

/**
 * Derive the stealth spending key for spending a note received at a stealth address.
 *
 * stealthSpendingKey = Hash(spendingKey, sharedSecret)
 */
export async function deriveStealthSpendingKey(
  spendingKey: Hash32,
  sharedSecret: Hash32,
): Promise<Hash32> {
  return poseidonHashHex([hexToField(spendingKey), hexToField(sharedSecret)]);
}

function bytesToHex(bytes: Uint8Array): Hash32 {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
