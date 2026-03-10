//! ECDH-based note encryption using BabyJubJub + HKDF-SHA256 + ChaCha20-Poly1305.
//!
//! Sender encrypts note data using a shared secret derived from ECDH.
//! For on-chain storage, the encrypted note is emitted as a program log event,
//! and the ephemeral public key is included for recipient decryption.

use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EncryptionError {
    #[error("Encryption failed")]
    EncryptionFailed,
    #[error("Decryption failed")]
    DecryptionFailed,
    #[error("Invalid key length")]
    InvalidKeyLength,
}

/// Info string for HKDF domain separation.
const HKDF_INFO: &[u8] = b"holanc-note-encryption-v1";

/// Derive a symmetric encryption key from an ECDH shared secret.
fn derive_symmetric_key(shared_secret: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, shared_secret);
    let mut key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut key)
        .expect("HKDF expand should not fail for 32-byte output");
    key
}

/// Encrypt a note payload using a shared secret (from ECDH).
///
/// Returns (ciphertext, nonce). The nonce is randomly generated.
pub fn encrypt_note(
    shared_secret: &[u8; 32],
    plaintext: &[u8],
) -> Result<(Vec<u8>, [u8; 12]), EncryptionError> {
    let key = derive_symmetric_key(shared_secret);
    let cipher =
        ChaCha20Poly1305::new_from_slice(&key).map_err(|_| EncryptionError::InvalidKeyLength)?;

    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| EncryptionError::EncryptionFailed)?;

    Ok((ciphertext, nonce_bytes))
}

/// Decrypt a note payload using a shared secret (from ECDH).
pub fn decrypt_note(
    shared_secret: &[u8; 32],
    ciphertext: &[u8],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, EncryptionError> {
    let key = derive_symmetric_key(shared_secret);
    let cipher =
        ChaCha20Poly1305::new_from_slice(&key).map_err(|_| EncryptionError::InvalidKeyLength)?;

    let nonce = Nonce::from_slice(nonce);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| EncryptionError::DecryptionFailed)
}

/// Encrypted note bundle: contains everything needed for the recipient to decrypt.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct EncryptedNote {
    /// The sender's ephemeral public key (for ECDH).
    pub ephemeral_pubkey: [u8; 32],
    /// ChaCha20-Poly1305 nonce.
    pub nonce: [u8; 12],
    /// Encrypted note data.
    pub ciphertext: Vec<u8>,
}

impl EncryptedNote {
    /// Serialize to bytes for on-chain emission.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(32 + 12 + self.ciphertext.len());
        bytes.extend_from_slice(&self.ephemeral_pubkey);
        bytes.extend_from_slice(&self.nonce);
        bytes.extend_from_slice(&self.ciphertext);
        bytes
    }

    /// Deserialize from bytes.
    pub fn from_bytes(data: &[u8]) -> Result<Self, EncryptionError> {
        if data.len() < 44 {
            return Err(EncryptionError::DecryptionFailed);
        }
        let mut ephemeral_pubkey = [0u8; 32];
        ephemeral_pubkey.copy_from_slice(&data[0..32]);
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&data[32..44]);
        let ciphertext = data[44..].to_vec();
        Ok(EncryptedNote {
            ephemeral_pubkey,
            nonce,
            ciphertext,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let shared_secret = [42u8; 32];
        let plaintext = b"test note data with value=100";

        let (ciphertext, nonce) = encrypt_note(&shared_secret, plaintext).unwrap();
        let decrypted = decrypt_note(&shared_secret, &ciphertext, &nonce).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let secret1 = [1u8; 32];
        let secret2 = [2u8; 32];
        let plaintext = b"secret data";

        let (ciphertext, nonce) = encrypt_note(&secret1, plaintext).unwrap();
        let result = decrypt_note(&secret2, &ciphertext, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_encrypted_note_serialization() {
        let note = EncryptedNote {
            ephemeral_pubkey: [1u8; 32],
            nonce: [2u8; 12],
            ciphertext: vec![3u8; 50],
        };

        let bytes = note.to_bytes();
        let decoded = EncryptedNote::from_bytes(&bytes).unwrap();

        assert_eq!(decoded.ephemeral_pubkey, note.ephemeral_pubkey);
        assert_eq!(decoded.nonce, note.nonce);
        assert_eq!(decoded.ciphertext, note.ciphertext);
    }
}
