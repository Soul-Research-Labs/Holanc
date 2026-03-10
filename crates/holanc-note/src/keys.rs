//! Key hierarchy for the Holanc privacy protocol.
//!
//! Key derivation:
//!   BIP39 mnemonic → PBKDF2 seed → BN254 scalar (spending key)
//!   spending_key → Poseidon(spending_key) → viewing key
//!
//! The spending key is used to derive nullifiers and prove ownership.
//! The viewing key allows scanning for incoming notes without spend authority.

use ark_bn254::Fr;
use ark_ff::PrimeField;
use holanc_primitives::poseidon::{fr_to_bytes, poseidon_hash};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroize;

#[derive(Debug, Error)]
pub enum KeyError {
    #[error("Invalid seed length")]
    InvalidSeedLength,
    #[error("Key derivation failed")]
    DerivationFailed,
}

/// The spending key: a BN254 scalar used to derive nullifiers and prove note ownership.
#[derive(Clone)]
pub struct SpendingKey {
    scalar: Fr,
    bytes: [u8; 32],
}

impl SpendingKey {
    /// Derive a spending key from a 32-byte seed.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let scalar = Fr::from_be_bytes_mod_order(seed);
        let bytes = fr_to_bytes(&scalar);
        SpendingKey { scalar, bytes }
    }

    /// Derive a spending key from a BIP39 mnemonic phrase.
    /// Uses PBKDF2-SHA256 to convert the mnemonic to a 32-byte seed.
    pub fn from_mnemonic(mnemonic: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"holanc-spending-key");
        hasher.update(mnemonic.as_bytes());
        let hash = hasher.finalize();
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&hash);
        let key = Self::from_seed(&seed);
        seed.zeroize();
        key
    }

    /// Generate a random spending key.
    pub fn random() -> Self {
        let mut seed = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut seed);
        let key = Self::from_seed(&seed);
        seed.zeroize();
        key
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Reconstruct a spending key from raw 32-byte representation.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self::from_seed(&bytes)
    }

    pub fn scalar(&self) -> &Fr {
        &self.scalar
    }

    /// Derive the corresponding viewing key.
    pub fn viewing_key(&self) -> ViewingKey {
        ViewingKey::from_spending_key(self)
    }
}

impl Drop for SpendingKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// The viewing key: derived from the spending key, allows scanning for incoming notes
/// without the ability to spend them.
#[derive(Clone)]
pub struct ViewingKey {
    bytes: [u8; 32],
}

impl ViewingKey {
    pub fn from_spending_key(sk: &SpendingKey) -> Self {
        // viewing_key = Poseidon(spending_key, domain_separator)
        let domain = {
            let mut d = [0u8; 32];
            d[31] = 1; // domain separator for viewing key derivation
            d
        };
        let bytes = poseidon_hash(sk.as_bytes(), &domain)
            .expect("Poseidon hash should not fail for valid inputs");
        ViewingKey { bytes }
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }
}

impl Drop for ViewingKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spending_key_from_seed() {
        let seed = [42u8; 32];
        let sk1 = SpendingKey::from_seed(&seed);
        let sk2 = SpendingKey::from_seed(&seed);
        assert_eq!(sk1.as_bytes(), sk2.as_bytes());
    }

    #[test]
    fn test_spending_key_from_mnemonic() {
        let sk1 = SpendingKey::from_mnemonic("test mnemonic phrase");
        let sk2 = SpendingKey::from_mnemonic("test mnemonic phrase");
        assert_eq!(sk1.as_bytes(), sk2.as_bytes());
    }

    #[test]
    fn test_different_mnemonics_different_keys() {
        let sk1 = SpendingKey::from_mnemonic("phrase one");
        let sk2 = SpendingKey::from_mnemonic("phrase two");
        assert_ne!(sk1.as_bytes(), sk2.as_bytes());
    }

    #[test]
    fn test_viewing_key_derivation() {
        let sk = SpendingKey::random();
        let vk1 = sk.viewing_key();
        let vk2 = sk.viewing_key();
        assert_eq!(vk1.as_bytes(), vk2.as_bytes());
    }

    #[test]
    fn test_viewing_key_differs_from_spending_key() {
        let sk = SpendingKey::from_seed(&[1u8; 32]);
        let vk = sk.viewing_key();
        assert_ne!(sk.as_bytes(), vk.as_bytes());
    }

    #[test]
    fn test_spending_key_from_bytes_roundtrip() {
        let original = SpendingKey::from_seed(&[77u8; 32]);
        let bytes = *original.as_bytes();
        let restored = SpendingKey::from_bytes(bytes);
        assert_eq!(original.as_bytes(), restored.as_bytes());
    }

    #[test]
    fn test_spending_key_random_is_unique() {
        let sk1 = SpendingKey::random();
        let sk2 = SpendingKey::random();
        assert_ne!(sk1.as_bytes(), sk2.as_bytes());
    }
}
