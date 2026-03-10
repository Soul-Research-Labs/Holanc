//! Fixed-size proof envelope for metadata resistance.
//!
//! All proofs are padded to exactly ENVELOPE_SIZE bytes before transmission,
//! preventing observers from distinguishing proof types (deposit vs transfer vs
//! withdraw) based on proof size.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Fixed size for all proof envelopes (2048 bytes).
pub const ENVELOPE_SIZE: usize = 2048;

/// Magic bytes identifying a Holanc proof envelope.
const MAGIC: [u8; 4] = [0x48, 0x4F, 0x4C, 0x43]; // "HOLC"

/// Envelope version.
const VERSION: u8 = 1;

/// Header size: magic(4) + version(1) + circuit_type(1) + payload_len(2) = 8.
const HEADER_SIZE: usize = 8;

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("Proof payload too large: {0} bytes (max {1})")]
    PayloadTooLarge(usize, usize),
    #[error("Invalid envelope magic bytes")]
    InvalidMagic,
    #[error("Unsupported envelope version: {0}")]
    UnsupportedVersion(u8),
    #[error("Envelope size mismatch")]
    SizeMismatch,
}

/// Circuit type identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CircuitType {
    Deposit = 0,
    Transfer = 1,
    Withdraw = 2,
    CrossChainLock = 3,
    WealthProof = 4,
}

impl TryFrom<u8> for CircuitType {
    type Error = EnvelopeError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(CircuitType::Deposit),
            1 => Ok(CircuitType::Transfer),
            2 => Ok(CircuitType::Withdraw),
            3 => Ok(CircuitType::CrossChainLock),
            4 => Ok(CircuitType::WealthProof),
            v => Err(EnvelopeError::UnsupportedVersion(v)),
        }
    }
}

/// A fixed-size proof envelope for metadata-resistant proof transmission.
#[derive(Clone)]
pub struct ProofEnvelope {
    pub data: [u8; ENVELOPE_SIZE],
}

impl ProofEnvelope {
    /// Wrap a proof payload into a fixed-size envelope.
    /// The payload is padded with random bytes to fill ENVELOPE_SIZE.
    pub fn wrap(circuit_type: CircuitType, payload: &[u8]) -> Result<Self, EnvelopeError> {
        let max_payload = ENVELOPE_SIZE - HEADER_SIZE;
        if payload.len() > max_payload {
            return Err(EnvelopeError::PayloadTooLarge(payload.len(), max_payload));
        }

        let mut data = [0u8; ENVELOPE_SIZE];

        // Header
        data[0..4].copy_from_slice(&MAGIC);
        data[4] = VERSION;
        data[5] = circuit_type as u8;
        let len = payload.len() as u16;
        data[6..8].copy_from_slice(&len.to_be_bytes());

        // Payload
        data[HEADER_SIZE..HEADER_SIZE + payload.len()].copy_from_slice(payload);

        // Padding: fill remainder with random bytes for indistinguishability
        let pad_start = HEADER_SIZE + payload.len();
        if pad_start < ENVELOPE_SIZE {
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut data[pad_start..]);
        }

        Ok(ProofEnvelope { data })
    }

    /// Unwrap a proof envelope, returning the circuit type and proof payload.
    pub fn unwrap(&self) -> Result<(CircuitType, &[u8]), EnvelopeError> {
        // Validate magic
        if self.data[0..4] != MAGIC {
            return Err(EnvelopeError::InvalidMagic);
        }

        // Validate version
        if self.data[4] != VERSION {
            return Err(EnvelopeError::UnsupportedVersion(self.data[4]));
        }

        let circuit_type = CircuitType::try_from(self.data[5])?;
        let payload_len = u16::from_be_bytes([self.data[6], self.data[7]]) as usize;

        let max_payload = ENVELOPE_SIZE - HEADER_SIZE;
        if payload_len > max_payload {
            return Err(EnvelopeError::SizeMismatch);
        }

        Ok((circuit_type, &self.data[HEADER_SIZE..HEADER_SIZE + payload_len]))
    }

    /// Get the raw envelope bytes.
    pub fn as_bytes(&self) -> &[u8; ENVELOPE_SIZE] {
        &self.data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_envelope_wrap_unwrap() {
        let payload = vec![1u8; 500];
        let env = ProofEnvelope::wrap(CircuitType::Transfer, &payload).unwrap();
        assert_eq!(env.data.len(), ENVELOPE_SIZE);

        let (ct, data) = env.unwrap().unwrap();
        assert_eq!(ct, CircuitType::Transfer);
        assert_eq!(data, &payload[..]);
    }

    #[test]
    fn test_envelope_fixed_size() {
        let small = ProofEnvelope::wrap(CircuitType::Deposit, &[1u8; 100]).unwrap();
        let large = ProofEnvelope::wrap(CircuitType::Withdraw, &[1u8; 1000]).unwrap();
        assert_eq!(small.data.len(), large.data.len());
        assert_eq!(small.data.len(), ENVELOPE_SIZE);
    }

    #[test]
    fn test_envelope_payload_too_large() {
        let payload = vec![0u8; ENVELOPE_SIZE]; // exceeds max
        let result = ProofEnvelope::wrap(CircuitType::Transfer, &payload);
        assert!(result.is_err());
    }

    #[test]
    fn test_envelope_invalid_magic() {
        let mut env = ProofEnvelope::wrap(CircuitType::Transfer, &[1u8; 100]).unwrap();
        env.data[0] = 0xFF;
        assert!(env.unwrap().is_err());
    }

    #[test]
    fn test_all_circuit_types() {
        for ct in [
            CircuitType::Deposit,
            CircuitType::Transfer,
            CircuitType::Withdraw,
            CircuitType::CrossChainLock,
            CircuitType::WealthProof,
        ] {
            let env = ProofEnvelope::wrap(ct, &[42u8; 200]).unwrap();
            let (unwrapped_ct, _) = env.unwrap().unwrap();
            assert_eq!(ct, unwrapped_ct);
        }
    }
}
