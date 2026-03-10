//! Poseidon hash function over BN254 scalar field.
//!
//! Uses the light-poseidon crate which provides an optimized Poseidon
//! implementation compatible with circomlib's Poseidon (width=3, rate=2).

use ark_bn254::Fr;
use ark_ff::{BigInteger, BigInteger256, PrimeField};
use light_poseidon::{Poseidon, PoseidonHasher};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PoseidonError {
    #[error("Poseidon hash computation failed")]
    HashFailed,
    #[error("Invalid input length: expected 32 bytes, got {0}")]
    InvalidInputLength(usize),
}

/// Compute Poseidon hash of two BN254 field elements.
/// Returns the hash as a 32-byte big-endian array.
pub fn poseidon_hash(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let l = Fr::from_be_bytes_mod_order(left);
    let r = Fr::from_be_bytes_mod_order(right);

    let mut hasher = Poseidon::<Fr>::new_circom(2).map_err(|_| PoseidonError::HashFailed)?;
    let result = hasher.hash(&[l, r]).map_err(|_| PoseidonError::HashFailed)?;

    Ok(fr_to_bytes(&result))
}

/// Compute Poseidon hash of multiple BN254 field elements (up to 16).
pub fn poseidon_hash_multi(inputs: &[[u8; 32]]) -> Result<[u8; 32], PoseidonError> {
    let field_elements: Vec<Fr> = inputs
        .iter()
        .map(|b| Fr::from_be_bytes_mod_order(b))
        .collect();

    let mut hasher =
        Poseidon::<Fr>::new_circom(field_elements.len()).map_err(|_| PoseidonError::HashFailed)?;
    let result = hasher
        .hash(&field_elements)
        .map_err(|_| PoseidonError::HashFailed)?;

    Ok(fr_to_bytes(&result))
}

/// Convert a BN254 scalar field element to a 32-byte big-endian array.
pub fn fr_to_bytes(fr: &Fr) -> [u8; 32] {
    let bigint: BigInteger256 = (*fr).into();
    let le_bytes = bigint.to_bytes_be();
    let mut result = [0u8; 32];
    let len = le_bytes.len().min(32);
    result[32 - len..].copy_from_slice(&le_bytes[..len]);
    result
}

/// Convert a 32-byte big-endian array to a BN254 scalar field element.
pub fn bytes_to_fr(bytes: &[u8; 32]) -> Fr {
    Fr::from_be_bytes_mod_order(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_poseidon_hash_deterministic() {
        let a = [0u8; 32];
        let b = [0u8; 32];
        let h1 = poseidon_hash(&a, &b).unwrap();
        let h2 = poseidon_hash(&a, &b).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_poseidon_hash_different_inputs() {
        let a = [0u8; 32];
        let mut b = [0u8; 32];
        b[31] = 1;
        let h1 = poseidon_hash(&a, &a).unwrap();
        let h2 = poseidon_hash(&a, &b).unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_fr_roundtrip() {
        let mut bytes = [0u8; 32];
        bytes[31] = 42;
        let fr = bytes_to_fr(&bytes);
        let result = fr_to_bytes(&fr);
        assert_eq!(bytes, result);
    }

    #[test]
    fn test_poseidon_hash_multi() {
        let inputs: Vec<[u8; 32]> = (0..4).map(|i| {
            let mut b = [0u8; 32];
            b[31] = i;
            b
        }).collect();
        let result = poseidon_hash_multi(&inputs).unwrap();
        assert_ne!(result, [0u8; 32]);
    }
}
