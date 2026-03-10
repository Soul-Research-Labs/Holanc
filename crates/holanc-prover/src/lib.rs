//! # holanc-prover
//!
//! Off-chain proof generation for the Holanc privacy protocol.
//! Prepares circuit inputs and invokes snarkjs for Groth16 proof generation.

pub mod inputs;

use holanc_note::note::Note;
use holanc_tree::MerkleProof;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProverError {
    #[error("Failed to generate circuit inputs: {0}")]
    InputGenerationFailed(String),
    #[error("Proof generation failed: {0}")]
    ProofGenerationFailed(String),
    #[error("Insufficient input value")]
    InsufficientValue,
}

/// A Groth16 proof with public inputs, ready for on-chain verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Groth16Proof {
    /// π_A point (G1, 64 bytes uncompressed)
    pub pi_a: Vec<String>,
    /// π_B point (G2, 128 bytes uncompressed)
    pub pi_b: Vec<Vec<String>>,
    /// π_C point (G1, 64 bytes uncompressed)
    pub pi_c: Vec<String>,
    /// Public signals (field element strings)
    pub public_signals: Vec<String>,
}

/// Parameters for generating a transfer proof.
#[derive(Debug, Clone)]
pub struct TransferParams {
    pub spending_key: [u8; 32],
    pub input_notes: [Note; 2],
    pub input_proofs: [MerkleProof; 2],
    pub output_notes: [Note; 2],
    pub fee: u64,
}

/// Parameters for generating a withdraw proof.
#[derive(Debug, Clone)]
pub struct WithdrawParams {
    pub spending_key: [u8; 32],
    pub input_notes: [Note; 2],
    pub input_proofs: [MerkleProof; 2],
    pub output_notes: [Note; 2],
    pub exit_value: u64,
    pub fee: u64,
}
