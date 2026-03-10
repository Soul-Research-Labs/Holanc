//! # holanc-primitives
//!
//! Core cryptographic primitives for the Holanc privacy protocol.
//! Provides Poseidon hashing over BN254, note commitments, nullifier derivation,
//! and fixed-size proof envelopes for metadata resistance.

pub mod commitment;
pub mod envelope;
pub mod nullifier;
pub mod poseidon;

pub use commitment::{note_commitment, NoteCommitment};
pub use envelope::ProofEnvelope;
pub use nullifier::{nullifier_v1, nullifier_v2};
pub use poseidon::poseidon_hash;
