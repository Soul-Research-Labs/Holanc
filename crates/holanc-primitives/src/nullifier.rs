//! Nullifier derivation for double-spend prevention.
//!
//! V1 nullifier: Poseidon(spending_key, note_commitment)
//! V2 nullifier: Poseidon(Poseidon(spending_key, commitment), Poseidon(chain_id, app_id))
//!
//! V2 provides domain separation for cross-chain privacy, ensuring the same note
//! produces different nullifiers on different chains/apps.

use crate::poseidon::{poseidon_hash, PoseidonError};

/// Derive a V1 nullifier (single-chain).
///   nullifier = Poseidon(spending_key, note_commitment)
pub fn nullifier_v1(
    spending_key: &[u8; 32],
    note_commitment: &[u8; 32],
) -> Result<[u8; 32], PoseidonError> {
    poseidon_hash(spending_key, note_commitment)
}

/// Derive a V2 nullifier (domain-separated, cross-chain safe).
///   inner = Poseidon(spending_key, note_commitment)
///   domain = Poseidon(chain_id, app_id)
///   nullifier = Poseidon(inner, domain)
pub fn nullifier_v2(
    spending_key: &[u8; 32],
    note_commitment: &[u8; 32],
    chain_id: u64,
    app_id: u64,
) -> Result<[u8; 32], PoseidonError> {
    let inner = poseidon_hash(spending_key, note_commitment)?;
    let chain_bytes = u64_to_field_bytes(chain_id);
    let app_bytes = u64_to_field_bytes(app_id);
    let domain = poseidon_hash(&chain_bytes, &app_bytes)?;
    poseidon_hash(&inner, &domain)
}

fn u64_to_field_bytes(value: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&value.to_be_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nullifier_v1_deterministic() {
        let sk = [1u8; 32];
        let cm = [2u8; 32];
        let n1 = nullifier_v1(&sk, &cm).unwrap();
        let n2 = nullifier_v1(&sk, &cm).unwrap();
        assert_eq!(n1, n2);
    }

    #[test]
    fn test_nullifier_v1_different_keys() {
        let cm = [2u8; 32];
        let n1 = nullifier_v1(&[1u8; 32], &cm).unwrap();
        let n2 = nullifier_v1(&[3u8; 32], &cm).unwrap();
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_nullifier_v2_domain_separation() {
        let sk = [1u8; 32];
        let cm = [2u8; 32];
        // Same note, different chains → different nullifiers
        let n1 = nullifier_v2(&sk, &cm, 1, 42).unwrap();
        let n2 = nullifier_v2(&sk, &cm, 2, 42).unwrap();
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_nullifier_v2_different_apps() {
        let sk = [1u8; 32];
        let cm = [2u8; 32];
        let n1 = nullifier_v2(&sk, &cm, 1, 1).unwrap();
        let n2 = nullifier_v2(&sk, &cm, 1, 2).unwrap();
        assert_ne!(n1, n2);
    }

    #[test]
    fn test_nullifier_v1_v2_differ() {
        let sk = [1u8; 32];
        let cm = [2u8; 32];
        let v1 = nullifier_v1(&sk, &cm).unwrap();
        let v2 = nullifier_v2(&sk, &cm, 0, 0).unwrap();
        // V1 and V2 should produce different nullifiers even with chain_id=0, app_id=0
        // because V2 adds an extra hash layer
        assert_ne!(v1, v2);
    }
}
