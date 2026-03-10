//! Note commitment derivation.
//!
//! A note commitment binds (owner, value, asset_id, blinding) together:
//!   commitment = Poseidon(owner, value, asset_id, blinding)
//!
//! This matches the in-circuit commitment computation used by the Circom circuits.

use crate::poseidon::{poseidon_hash, poseidon_hash_multi, PoseidonError};
use serde::{Deserialize, Serialize};

/// A 32-byte note commitment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteCommitment(pub [u8; 32]);

impl NoteCommitment {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl AsRef<[u8; 32]> for NoteCommitment {
    fn as_ref(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Compute a note commitment:
///   commitment = Poseidon(owner, value, asset_id, blinding)
///
/// All inputs are 32-byte big-endian field elements.
/// `value` is a u64 encoded as 32-byte big-endian.
pub fn note_commitment(
    owner: &[u8; 32],
    value: u64,
    asset_id: &[u8; 32],
    blinding: &[u8; 32],
) -> Result<NoteCommitment, PoseidonError> {
    let value_bytes = u64_to_field_bytes(value);
    let hash = poseidon_hash_multi(&[*owner, value_bytes, *asset_id, *blinding])?;
    Ok(NoteCommitment(hash))
}

/// Compute a simplified commitment for deposit (without asset_id):
///   commitment = Poseidon(owner, value, blinding)
pub fn deposit_commitment(
    owner: &[u8; 32],
    value: u64,
    blinding: &[u8; 32],
) -> Result<NoteCommitment, PoseidonError> {
    let value_bytes = u64_to_field_bytes(value);
    let hash = poseidon_hash_multi(&[*owner, value_bytes, *blinding])?;
    Ok(NoteCommitment(hash))
}

/// Hash two commitments together (for Merkle tree internal nodes).
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    poseidon_hash(left, right)
}

/// Encode a u64 value as a 32-byte big-endian field element.
fn u64_to_field_bytes(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_note_commitment_deterministic() {
        let owner = [1u8; 32];
        let value = 100u64;
        let asset_id = [2u8; 32];
        let blinding = [3u8; 32];

        let c1 = note_commitment(&owner, value, &asset_id, &blinding).unwrap();
        let c2 = note_commitment(&owner, value, &asset_id, &blinding).unwrap();
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_different_values_different_commitments() {
        let owner = [1u8; 32];
        let asset_id = [2u8; 32];
        let blinding = [3u8; 32];

        let c1 = note_commitment(&owner, 100, &asset_id, &blinding).unwrap();
        let c2 = note_commitment(&owner, 200, &asset_id, &blinding).unwrap();
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_hash_pair() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let h = hash_pair(&a, &b).unwrap();
        assert_ne!(h, [0u8; 32]);
    }

    #[test]
    fn test_u64_to_field_bytes() {
        let bytes = u64_to_field_bytes(100);
        assert_eq!(bytes[31], 100);
        assert_eq!(bytes[0], 0);
    }

    #[test]
    fn test_deposit_commitment_deterministic() {
        let owner = [1u8; 32];
        let value = 500u64;
        let blinding = [3u8; 32];

        let c1 = deposit_commitment(&owner, value, &blinding).unwrap();
        let c2 = deposit_commitment(&owner, value, &blinding).unwrap();
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_deposit_commitment_differs_from_note_commitment() {
        let owner = [1u8; 32];
        let value = 100u64;
        let blinding = [3u8; 32];
        let asset_id = [0u8; 32];

        let dc = deposit_commitment(&owner, value, &blinding).unwrap();
        let nc = note_commitment(&owner, value, &asset_id, &blinding).unwrap();
        // 3-input vs 4-input hash should differ even with zero asset_id
        assert_ne!(dc, nc);
    }

    #[test]
    fn test_hash_pair_is_non_commutative() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let h1 = hash_pair(&a, &b).unwrap();
        let h2 = hash_pair(&b, &a).unwrap();
        assert_ne!(h1, h2, "Poseidon hash pair should be non-commutative");
    }
}
