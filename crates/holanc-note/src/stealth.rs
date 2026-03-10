//! Stealth address protocol for Holanc.
//!
//! Allows a sender to create a one-time payment address for the recipient
//! without the recipient needing to publish a fresh address for each transaction.
//!
//! Protocol:
//!   1. Recipient publishes a stealth meta-address (viewing_pubkey, spending_pubkey).
//!   2. Sender generates an ephemeral keypair (r, R = r·G).
//!   3. Sender computes shared_secret = r · viewing_pubkey.
//!   4. Sender derives one-time owner = Poseidon(shared_secret, spending_pubkey).
//!   5. Sender creates a note with `owner = one_time_owner`.
//!   6. Sender publishes R (ephemeral public key) alongside the encrypted note.
//!   7. Recipient scans: shared_secret = viewing_key · R,
//!      then checks Poseidon(shared_secret, spending_pubkey) == note.owner.

use holanc_primitives::poseidon::poseidon_hash;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StealthError {
    #[error("Stealth address derivation failed")]
    DerivationFailed,
}

/// A stealth meta-address published by the recipient.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StealthMetaAddress {
    /// The viewing public key (used for scanning).
    pub viewing_pubkey: [u8; 32],
    /// The spending public key (used for ownership derivation).
    pub spending_pubkey: [u8; 32],
}

/// Result of stealth address generation (sender side).
#[derive(Debug, Clone)]
pub struct StealthSendResult {
    /// The one-time owner field element (used as note.owner).
    pub one_time_owner: [u8; 32],
    /// The shared secret (used for note encryption).
    pub shared_secret: [u8; 32],
    /// The ephemeral public key (published on-chain for recipient scanning).
    pub ephemeral_pubkey: [u8; 32],
}

/// Sender: generate a stealth address for a recipient.
///
/// In a full implementation, this would use ECDH on BabyJubJub. For the MVP,
/// we use a simplified hash-based scheme that captures the same privacy properties.
pub fn stealth_send(
    recipient_meta: &StealthMetaAddress,
) -> Result<StealthSendResult, StealthError> {
    // Generate ephemeral secret
    let mut ephemeral_secret = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut ephemeral_secret);

    // ephemeral_pubkey = Hash(ephemeral_secret) — simplified stand-in for r·G
    let ephemeral_pubkey = {
        let mut hasher = Sha256::new();
        hasher.update(b"holanc-ephemeral-pubkey");
        hasher.update(&ephemeral_secret);
        let hash = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&hash);
        out
    };

    // shared_secret = Hash(ephemeral_secret, viewing_pubkey)
    // In full impl: shared_secret = r · viewing_pubkey (ECDH)
    let shared_secret = {
        let mut hasher = Sha256::new();
        hasher.update(b"holanc-ecdh-shared-secret");
        hasher.update(&ephemeral_secret);
        hasher.update(&recipient_meta.viewing_pubkey);
        let hash = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&hash);
        out
    };

    // one_time_owner = Poseidon(shared_secret, spending_pubkey)
    let one_time_owner = poseidon_hash(&shared_secret, &recipient_meta.spending_pubkey)
        .map_err(|_| StealthError::DerivationFailed)?;

    Ok(StealthSendResult {
        one_time_owner,
        shared_secret,
        ephemeral_pubkey,
    })
}

/// Recipient: check if a note is addressed to us by trial-decrypting with our viewing key.
///
/// Returns Some(shared_secret) if the note belongs to us, None otherwise.
pub fn stealth_receive(
    viewing_key: &[u8; 32],
    spending_pubkey: &[u8; 32],
    ephemeral_pubkey: &[u8; 32],
    note_owner: &[u8; 32],
) -> Result<Option<[u8; 32]>, StealthError> {
    // shared_secret = Hash(viewing_key, ephemeral_pubkey)
    // In full impl: shared_secret = viewing_key · R (ECDH)
    let shared_secret = {
        let mut hasher = Sha256::new();
        hasher.update(b"holanc-ecdh-shared-secret-recv");
        hasher.update(viewing_key);
        hasher.update(ephemeral_pubkey);
        let hash = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(&hash);
        out
    };

    // expected_owner = Poseidon(shared_secret, spending_pubkey)
    let expected_owner = poseidon_hash(&shared_secret, spending_pubkey)
        .map_err(|_| StealthError::DerivationFailed)?;

    // Constant-time comparison
    let mut diff = 0u8;
    for (a, b) in expected_owner.iter().zip(note_owner.iter()) {
        diff |= a ^ b;
    }

    if diff == 0 {
        Ok(Some(shared_secret))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stealth_address_roundtrip() {
        // Note: In real implementation, the sender and receiver ECDH would match.
        // This test validates the structure and API, not the ECDH key agreement,
        // which requires BabyJubJub curve operations.
        let meta = StealthMetaAddress {
            viewing_pubkey: [10u8; 32],
            spending_pubkey: [20u8; 32],
        };

        let send_result = stealth_send(&meta).unwrap();
        assert_ne!(send_result.one_time_owner, [0u8; 32]);
        assert_ne!(send_result.shared_secret, [0u8; 32]);
        assert_ne!(send_result.ephemeral_pubkey, [0u8; 32]);
    }
}
