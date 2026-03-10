import { Hash32 } from "./types";
import { poseidonHash, fieldToHex, hexToField } from "./poseidon";

/**
 * Note encryption / decryption using AES-256-GCM.
 *
 * Encrypted notes allow a sender to transmit note details (value, blinding)
 * to a recipient so they can detect and spend incoming notes.
 *
 * Encryption scheme:
 *   1. Derive shared secret via ECDH (placeholder: hash-based KDF).
 *   2. Derive AES key from shared secret using HKDF-SHA256.
 *   3. Encrypt plaintext with AES-256-GCM (random 12-byte IV).
 *   4. Output: IV || ciphertext || tag (12 + len + 16 bytes).
 *
 * In production, the ECDH will use BabyJubJub on BN254 to match
 * the in-circuit key derivation.
 */

const HKDF_INFO = new TextEncoder().encode("holanc-note-v1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedNote {
  ephemeralPubKey: Hash32;
  ciphertext: Uint8Array;
}

export interface NotePlaintext {
  value: bigint;
  blinding: Hash32;
  assetId: Hash32;
}

/**
 * Encrypt a note for a recipient.
 *
 * @param plaintext   The note fields to encrypt.
 * @param senderKey   Sender's secret key (32 bytes hex).
 * @param recipientPub Recipient's public key (32 bytes hex).
 * @returns Encrypted note bundle.
 */
export async function encryptNote(
  plaintext: NotePlaintext,
  senderKey: Hash32,
  recipientPub: Hash32,
): Promise<EncryptedNote> {
  // Derive shared secret (placeholder: hash-based, will be BabyJubJub ECDH)
  const sharedSecret = await deriveSharedSecret(senderKey, recipientPub);

  // Derive AES key via HKDF
  const aesKey = await hkdfDeriveKey(sharedSecret);

  // Encode plaintext
  const ptBytes = encodePlaintext(plaintext);

  // Encrypt with AES-256-GCM
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    aesKey,
    "AES-GCM",
    false,
    ["encrypt"],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    ptBytes,
  );

  // Concatenate IV || ciphertext+tag
  const ciphertext = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  ciphertext.set(iv, 0);
  ciphertext.set(new Uint8Array(encrypted), IV_LENGTH);

  // Ephemeral public key derived via Poseidon(senderKey)
  const ephemeralField = await poseidonHash([hexToField(senderKey)]);
  const ephemeralPubKey = fieldToHex(ephemeralField);

  return { ephemeralPubKey, ciphertext };
}

/**
 * Decrypt a note using the recipient's secret key.
 *
 * @param encrypted    The encrypted note bundle.
 * @param recipientKey Recipient's secret key (32 bytes hex).
 * @returns Decrypted note plaintext, or null if decryption fails (not for us).
 */
export async function decryptNote(
  encrypted: EncryptedNote,
  recipientKey: Hash32,
): Promise<NotePlaintext | null> {
  try {
    const sharedSecret = await deriveSharedSecret(
      recipientKey,
      encrypted.ephemeralPubKey,
    );
    const aesKey = await hkdfDeriveKey(sharedSecret);

    const iv = encrypted.ciphertext.slice(0, IV_LENGTH);
    const ct = encrypted.ciphertext.slice(IV_LENGTH);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      aesKey,
      "AES-GCM",
      false,
      ["decrypt"],
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
      cryptoKey,
      ct,
    );

    return decodePlaintext(new Uint8Array(decrypted));
  } catch {
    // Decryption failure — note is not addressed to us
    return null;
  }
}

/**
 * Scan a batch of encrypted notes, attempting to decrypt each.
 * Returns all notes that decrypt successfully.
 */
export async function scanNotes(
  encryptedNotes: EncryptedNote[],
  recipientKey: Hash32,
): Promise<NotePlaintext[]> {
  const results: NotePlaintext[] = [];
  for (const enc of encryptedNotes) {
    const pt = await decryptNote(enc, recipientKey);
    if (pt) results.push(pt);
  }
  return results;
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/** Shared secret derivation via Poseidon(secretKey, publicKey). */
async function deriveSharedSecret(
  secretKey: Hash32,
  publicKey: Hash32,
): Promise<Uint8Array> {
  const result = await poseidonHash([
    hexToField(secretKey),
    hexToField(publicKey),
  ]);
  const hex = fieldToHex(result);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** HKDF-SHA256 key derivation. */
async function hkdfDeriveKey(ikm: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32), // zero salt for deterministic testing
      info: HKDF_INFO,
    },
    baseKey,
    256,
  );

  return new Uint8Array(derivedBits);
}

/** Encode note plaintext to bytes: value(8) || blinding(32) || assetId(32) = 72 bytes. */
function encodePlaintext(pt: NotePlaintext): Uint8Array {
  const buf = new Uint8Array(72);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, pt.value, true); // little-endian
  hexToBytes(pt.blinding, buf, 8);
  hexToBytes(pt.assetId, buf, 40);
  return buf;
}

/** Decode note plaintext from bytes. */
function decodePlaintext(buf: Uint8Array): NotePlaintext {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const value = view.getBigUint64(0, true);
  const blinding = bytesToHex(buf.slice(8, 40));
  const assetId = bytesToHex(buf.slice(40, 72));
  return { value, blinding, assetId };
}

function hexToBytes(hex: Hash32, target: Uint8Array, offset: number): void {
  for (let i = 0; i < 32; i++) {
    target[offset + i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
}

function bytesToHex(bytes: Uint8Array): Hash32 {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
