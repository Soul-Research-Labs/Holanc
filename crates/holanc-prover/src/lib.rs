//! # holanc-prover
//!
//! Off-chain proof generation for the Holanc privacy protocol.
//! Prepares circuit inputs and invokes snarkjs for Groth16 proof generation.

pub mod inputs;

use holanc_note::note::Note;
use holanc_tree::MerkleProof;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProverError {
    #[error("Failed to generate circuit inputs: {0}")]
    InputGenerationFailed(String),
    #[error("Proof generation failed: {0}")]
    ProofGenerationFailed(String),
    #[error("Insufficient input value")]
    InsufficientValue,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
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

/// Parameters for generating a deposit proof.
#[derive(Debug, Clone)]
pub struct DepositParams {
    pub owner: [u8; 32],
    pub value: u64,
    pub asset_id: [u8; 32],
    pub blinding: [u8; 32],
}

/// Parameters for stealth transfer proof.
#[derive(Debug, Clone)]
pub struct StealthTransferParams {
    pub transfer: TransferParams,
    pub ephemeral_key: [u8; 32],
    pub recipient_spending_pubkey: [u8; 32],
}

/// Parameters for wealth proof.
#[derive(Debug, Clone)]
pub struct WealthProofParams {
    pub spending_key: [u8; 32],
    pub input_notes: Vec<Note>,
    pub input_proofs: Vec<MerkleProof>,
    pub threshold: u64,
}

/// The Holanc prover — orchestrates circuit input building and snarkjs invocation.
pub struct HolancProver {
    circuit_dir: PathBuf,
}

impl HolancProver {
    pub fn new(circuit_dir: impl Into<PathBuf>) -> Self {
        Self {
            circuit_dir: circuit_dir.into(),
        }
    }

    /// Generate a Groth16 proof for a given circuit and input JSON.
    ///
    /// Invokes `snarkjs groth16 fullprove` as a subprocess, reading the WASM
    /// and zkey artifacts from `circuit_dir/<circuit_name>/`.
    pub fn prove(
        &self,
        circuit_name: &str,
        input: &serde_json::Value,
    ) -> Result<Groth16Proof, ProverError> {
        let circuit_path = self.circuit_dir.join(circuit_name);
        let wasm_path = circuit_path
            .join(format!("{circuit_name}_js"))
            .join(format!("{circuit_name}.wasm"));
        let zkey_path = circuit_path.join(format!("{circuit_name}_final.zkey"));

        // Write input to a temp file
        let input_path = circuit_path.join("input_tmp.json");
        let proof_path = circuit_path.join("proof_tmp.json");
        let public_path = circuit_path.join("public_tmp.json");

        std::fs::write(&input_path, serde_json::to_string_pretty(input)?)?;

        let output = Command::new("snarkjs")
            .args([
                "groth16",
                "fullprove",
                input_path.to_str().unwrap(),
                wasm_path.to_str().unwrap(),
                zkey_path.to_str().unwrap(),
                proof_path.to_str().unwrap(),
                public_path.to_str().unwrap(),
            ])
            .output()?;

        // Clean up input file
        let _ = std::fs::remove_file(&input_path);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = std::fs::remove_file(&proof_path);
            let _ = std::fs::remove_file(&public_path);
            return Err(ProverError::ProofGenerationFailed(stderr.to_string()));
        }

        let proof_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&proof_path)?)?;
        let public_signals: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(&public_path)?)?;

        // Clean up temp files
        let _ = std::fs::remove_file(&proof_path);
        let _ = std::fs::remove_file(&public_path);

        Ok(Groth16Proof {
            pi_a: proof_json["pi_a"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            pi_b: proof_json["pi_b"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| {
                    v.as_array().map(|inner| {
                        inner
                            .iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                })
                .collect(),
            pi_c: proof_json["pi_c"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            public_signals,
        })
    }

    /// Generate a transfer proof.
    pub fn prove_transfer(&self, params: &TransferParams) -> Result<Groth16Proof, ProverError> {
        let input = inputs::build_transfer_input(params)?;
        self.prove("transfer", &input)
    }

    /// Generate a withdraw proof.
    pub fn prove_withdraw(&self, params: &WithdrawParams) -> Result<Groth16Proof, ProverError> {
        let input = inputs::build_withdraw_input(params)?;
        self.prove("withdraw", &input)
    }

    /// Generate a deposit proof.
    pub fn prove_deposit(&self, params: &DepositParams) -> Result<Groth16Proof, ProverError> {
        let input = inputs::build_deposit_input(params)?;
        self.prove("deposit", &input)
    }

    /// Generate a stealth transfer proof.
    pub fn prove_stealth_transfer(
        &self,
        params: &StealthTransferParams,
    ) -> Result<Groth16Proof, ProverError> {
        let input = inputs::build_stealth_transfer_input(params)?;
        self.prove("stealth_transfer", &input)
    }

    /// Generate a wealth proof.
    pub fn prove_wealth(&self, params: &WealthProofParams) -> Result<Groth16Proof, ProverError> {
        let input = inputs::build_wealth_proof_input(params)?;
        self.prove("wealth_proof", &input)
    }
}
