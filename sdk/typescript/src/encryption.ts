import { Hash32 } from "./types";
import { poseidonHash, fieldToHex, hexToField } from "./poseidon";

/**
 * Note encryption / decryption using AES-256-GCM.
 *
 * Encrypted notes allow a sender to transmit note details (value, blinding)
 * to a recipient so they can detect and spend incoming notes.
 *
 * Encryption scheme:
 *   1. Derive shared secret via BabyJubJub ECDH.
 *   2. Derive AES key from shared secret using HKDF-SHA256.
 *   3. Encrypt plaintext with AES-256-GCM (random 12-byte IV).
 *   4. Output: IV || ciphertext || tag (12 + len + 16 bytes).
 */

// Lazy-loaded BabyJubJub instance (shared with stealth.ts)
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

const HKDF_INFO = new TextEncoder().encode("holanc-note-v1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface EncryptedNote {
  /** Ephemeral public key — BabyJubJub point [x, y] as hex strings. */
  ephemeralPubKey: [Hash32, Hash32];
  ciphertext: Uint8Array;
}

export interface NotePlaintext {
  value: bigint;
  blinding: Hash32;
  assetId: Hash32;
}

/**
 * Encrypt a note for a recipient using BabyJubJub ECDH.
 *
 * @param plaintext     The note fields to encrypt.
 * @param recipientPub  Recipient's BabyJubJub public key [x, y] hex strings.
 * @returns Encrypted note bundle with ephemeral pubkey for ECDH recovery.
 */
export async function encryptNote(
  plaintext: NotePlaintext,
  recipientPub: [Hash32, Hash32],
): Promise<EncryptedNote> {
  const babyjub = await getBabyjub();
  const poseidon = await getPoseidon();
  const F = babyjub.F;

  // Generate ephemeral scalar
  const ephBytes = crypto.getRandomValues(new Uint8Array(32));
  const ephScalar = BigInt("0x" + bytesToHex(ephBytes)) % babyjub.subOrder;
  if (ephScalar === 0n) {
    // Reject zero scalar — re-derive
    return encryptNote(plaintext, recipientPub);
  }

  // R = ephScalar * G (ephemeral pubkey)
  const R = babyjub.mulPointEscalar(babyjub.Base8, ephScalar);
  const ephemeralPubKey: [Hash32, Hash32] = [
    F.toObject(R[0]).toString(16).padStart(64, "0"),
    F.toObject(R[1]).toString(16).padStart(64, "0"),
  ];

  // ECDH: shared_point = ephScalar * recipientPub
  const recipPoint = [
    F.e(BigInt("0x" + recipientPub[0])),
    F.e(BigInt("0x" + recipientPub[1])),
  ];
  const sharedPoint = babyjub.mulPointEscalar(recipPoint, ephScalar);

  // shared_secret = Poseidon(shared_point.x, shared_point.y)
  const ssHash = poseidon([sharedPoint[0], sharedPoint[1]]);
  const ssHex = F.toObject(ssHash).toString(16).padStart(64, "0");
  const sharedSecret = hexToBytes32(ssHex);

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

  return { ephemeralPubKey, ciphertext };
}

/**
 * Decrypt a note using the recipient's BabyJubJub secret key.
 *
 * @param encrypted    The encrypted note bundle (includes ephemeral pubkey).
 * @param recipientKey Recipient's BabyJubJub secret scalar (hex).
 * @returns Decrypted note plaintext, or null if decryption fails (not for us).
 */
export async function decryptNote(
  encrypted: EncryptedNote,
  recipientKey: Hash32,
): Promise<NotePlaintext | null> {
  try {
    const babyjub = await getBabyjub();
    const poseidon = await getPoseidon();
    const F = babyjub.F;

    const viewingScalar = BigInt("0x" + recipientKey) % babyjub.subOrder;

    // Parse ephemeral pubkey
    const ephPoint = [
      F.e(BigInt("0x" + encrypted.ephemeralPubKey[0])),
      F.e(BigInt("0x" + encrypted.ephemeralPubKey[1])),
    ];

    // ECDH: shared_point = viewingKey * R (== ephScalar * viewingPub)
    const sharedPoint = babyjub.mulPointEscalar(ephPoint, viewingScalar);

    // shared_secret = Poseidon(shared_point.x, shared_point.y)
    const ssHash = poseidon([sharedPoint[0], sharedPoint[1]]);
    const ssHex = F.toObject(ssHash).toString(16).padStart(64, "0");
    const sharedSecret = hexToBytes32(ssHex);

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

/** Convert a 64-char hex string to a 32-byte Uint8Array. */
function hexToBytes32(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** HKDF-SHA256 key derivation. */
async function hkdfDeriveKey(ikm: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    "HKDF",
    false,
    ["deriveBits"],
  );

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
