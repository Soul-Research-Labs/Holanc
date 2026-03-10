//! Note model for the Holanc privacy protocol.
//!
//! A Note represents a shielded value entry in the privacy pool. Each note
//! has an owner (BN254 field element), a value, an asset identifier, and
//! a random blinding factor for commitment hiding.

use holanc_primitives::commitment::{note_commitment, NoteCommitment};
use holanc_primitives::nullifier::{nullifier_v1, nullifier_v2};
use serde::{Deserialize, Serialize};

/// A shielded note in the privacy pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    /// The owner's public key (BN254 field element, 32 bytes).
    pub owner: [u8; 32],
    /// The value stored in this note (in base token units).
    pub value: u64,
    /// Asset identifier (hash of token mint address, or zero for native SOL).
    pub asset_id: [u8; 32],
    /// Random blinding factor for commitment hiding.
    pub blinding: [u8; 32],
    /// The leaf index in the Merkle tree (set after deposit/transfer).
    pub leaf_index: Option<u64>,
    /// Whether this note has been spent.
    pub spent: bool,
}

impl Note {
    /// Create a new note with random blinding.
    pub fn new(owner: [u8; 32], value: u64, asset_id: [u8; 32]) -> Self {
        let mut blinding = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut blinding);
        Note {
            owner,
            value,
            asset_id,
            blinding,
            leaf_index: None,
            spent: false,
        }
    }

    /// Create a note with a specific blinding factor (for deterministic tests).
    pub fn with_blinding(
        owner: [u8; 32],
        value: u64,
        asset_id: [u8; 32],
        blinding: [u8; 32],
    ) -> Self {
        Note {
            owner,
            value,
            asset_id,
            blinding,
            leaf_index: None,
            spent: false,
        }
    }

    /// Compute the note commitment: Poseidon(owner, value, asset_id, blinding).
    pub fn commitment(&self) -> NoteCommitment {
        note_commitment(&self.owner, self.value, &self.asset_id, &self.blinding)
            .expect("commitment computation should not fail")
    }

    /// Derive the V1 nullifier for this note given the spending key.
    pub fn nullifier_v1(&self, spending_key: &[u8; 32]) -> [u8; 32] {
        let cm = self.commitment();
        nullifier_v1(spending_key, cm.as_bytes())
            .expect("nullifier computation should not fail")
    }

    /// Derive the V2 (domain-separated) nullifier for cross-chain use.
    pub fn nullifier_v2(&self, spending_key: &[u8; 32], chain_id: u64, app_id: u64) -> [u8; 32] {
        let cm = self.commitment();
        nullifier_v2(spending_key, cm.as_bytes(), chain_id, app_id)
            .expect("nullifier computation should not fail")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_owner() -> [u8; 32] {
        let mut o = [0u8; 32];
        o[31] = 1;
        o
    }

    #[test]
    fn test_note_commitment() {
        let note = Note::with_blinding(test_owner(), 100, [0u8; 32], [42u8; 32]);
        let cm1 = note.commitment();
        let cm2 = note.commitment();
        assert_eq!(cm1, cm2);
    }

    #[test]
    fn test_note_nullifier_v1() {
        let note = Note::with_blinding(test_owner(), 100, [0u8; 32], [42u8; 32]);
        let sk = [1u8; 32];
        let nf1 = note.nullifier_v1(&sk);
        let nf2 = note.nullifier_v1(&sk);
        assert_eq!(nf1, nf2);
    }

    #[test]
    fn test_note_nullifier_v2_domain_separation() {
        let note = Note::with_blinding(test_owner(), 100, [0u8; 32], [42u8; 32]);
        let sk = [1u8; 32];
        let nf_chain1 = note.nullifier_v2(&sk, 1, 0);
        let nf_chain2 = note.nullifier_v2(&sk, 2, 0);
        assert_ne!(nf_chain1, nf_chain2);
    }

    #[test]
    fn test_note_new_random_blinding() {
        let n1 = Note::new(test_owner(), 100, [0u8; 32]);
        let n2 = Note::new(test_owner(), 100, [0u8; 32]);
        // Random blinding means different commitments
        assert_ne!(n1.blinding, n2.blinding);
        assert_ne!(n1.commitment(), n2.commitment());
        assert!(!n1.spent);
        assert!(n1.leaf_index.is_none());
    }

    #[test]
    fn test_note_nullifier_v1_differs_for_different_keys() {
        let note = Note::with_blinding(test_owner(), 100, [0u8; 32], [42u8; 32]);
        let nf1 = note.nullifier_v1(&[1u8; 32]);
        let nf2 = note.nullifier_v1(&[2u8; 32]);
        assert_ne!(nf1, nf2);
    }
}
