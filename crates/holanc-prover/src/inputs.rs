//! Circuit input preparation for snarkjs proving.

use crate::{ProverError, TransferParams, WithdrawParams};
use serde_json::{json, Value};

/// Build the JSON input for the transfer circuit.
pub fn build_transfer_input(params: &TransferParams) -> Result<Value, ProverError> {
    let total_in: u64 = params.input_notes.iter().map(|n| n.value).sum();
    let total_out: u64 = params.output_notes.iter().map(|n| n.value).sum();
    if total_in < total_out + params.fee {
        return Err(ProverError::InsufficientValue);
    }

    Ok(json!({
        "spending_key": bytes_to_decimal(&params.spending_key),

        "in_owner": [
            bytes_to_decimal(&params.input_notes[0].owner),
            bytes_to_decimal(&params.input_notes[1].owner),
        ],
        "in_value": [
            params.input_notes[0].value.to_string(),
            params.input_notes[1].value.to_string(),
        ],
        "in_asset_id": [
            bytes_to_decimal(&params.input_notes[0].asset_id),
            bytes_to_decimal(&params.input_notes[1].asset_id),
        ],
        "in_blinding": [
            bytes_to_decimal(&params.input_notes[0].blinding),
            bytes_to_decimal(&params.input_notes[1].blinding),
        ],

        "merkle_path_elements": [
            params.input_proofs[0].path_elements.iter().map(|e| bytes_to_decimal(e)).collect::<Vec<_>>(),
            params.input_proofs[1].path_elements.iter().map(|e| bytes_to_decimal(e)).collect::<Vec<_>>(),
        ],
        "merkle_path_indices": [
            params.input_proofs[0].path_indices.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
            params.input_proofs[1].path_indices.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
        ],

        "out_owner": [
            bytes_to_decimal(&params.output_notes[0].owner),
            bytes_to_decimal(&params.output_notes[1].owner),
        ],
        "out_value": [
            params.output_notes[0].value.to_string(),
            params.output_notes[1].value.to_string(),
        ],
        "out_asset_id": [
            bytes_to_decimal(&params.output_notes[0].asset_id),
            bytes_to_decimal(&params.output_notes[1].asset_id),
        ],
        "out_blinding": [
            bytes_to_decimal(&params.output_notes[0].blinding),
            bytes_to_decimal(&params.output_notes[1].blinding),
        ],

        "merkle_root": bytes_to_decimal(&params.input_proofs[0].root),
        "nullifiers": [
            bytes_to_decimal(&params.input_notes[0].nullifier_v1(&params.spending_key)),
            bytes_to_decimal(&params.input_notes[1].nullifier_v1(&params.spending_key)),
        ],
        "output_commitments": [
            bytes_to_decimal(params.output_notes[0].commitment().as_bytes()),
            bytes_to_decimal(params.output_notes[1].commitment().as_bytes()),
        ],
        "fee": params.fee.to_string(),
    }))
}

/// Build the JSON input for the withdraw circuit.
pub fn build_withdraw_input(params: &WithdrawParams) -> Result<Value, ProverError> {
    let total_in: u64 = params.input_notes.iter().map(|n| n.value).sum();
    let total_out: u64 = params.output_notes.iter().map(|n| n.value).sum();
    if total_in < total_out + params.exit_value + params.fee {
        return Err(ProverError::InsufficientValue);
    }

    Ok(json!({
        "spending_key": bytes_to_decimal(&params.spending_key),

        "in_owner": [
            bytes_to_decimal(&params.input_notes[0].owner),
            bytes_to_decimal(&params.input_notes[1].owner),
        ],
        "in_value": [
            params.input_notes[0].value.to_string(),
            params.input_notes[1].value.to_string(),
        ],
        "in_asset_id": [
            bytes_to_decimal(&params.input_notes[0].asset_id),
            bytes_to_decimal(&params.input_notes[1].asset_id),
        ],
        "in_blinding": [
            bytes_to_decimal(&params.input_notes[0].blinding),
            bytes_to_decimal(&params.input_notes[1].blinding),
        ],

        "merkle_path_elements": [
            params.input_proofs[0].path_elements.iter().map(|e| bytes_to_decimal(e)).collect::<Vec<_>>(),
            params.input_proofs[1].path_elements.iter().map(|e| bytes_to_decimal(e)).collect::<Vec<_>>(),
        ],
        "merkle_path_indices": [
            params.input_proofs[0].path_indices.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
            params.input_proofs[1].path_indices.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
        ],

        "out_owner": [
            bytes_to_decimal(&params.output_notes[0].owner),
            bytes_to_decimal(&params.output_notes[1].owner),
        ],
        "out_value": [
            params.output_notes[0].value.to_string(),
            params.output_notes[1].value.to_string(),
        ],
        "out_asset_id": [
            bytes_to_decimal(&params.output_notes[0].asset_id),
            bytes_to_decimal(&params.output_notes[1].asset_id),
        ],
        "out_blinding": [
            bytes_to_decimal(&params.output_notes[0].blinding),
            bytes_to_decimal(&params.output_notes[1].blinding),
        ],

        "merkle_root": bytes_to_decimal(&params.input_proofs[0].root),
        "nullifiers": [
            bytes_to_decimal(&params.input_notes[0].nullifier_v1(&params.spending_key)),
            bytes_to_decimal(&params.input_notes[1].nullifier_v1(&params.spending_key)),
        ],
        "output_commitments": [
            bytes_to_decimal(params.output_notes[0].commitment().as_bytes()),
            bytes_to_decimal(params.output_notes[1].commitment().as_bytes()),
        ],
        "exit_value": params.exit_value.to_string(),
        "fee": params.fee.to_string(),
    }))
}

/// Convert a 32-byte big-endian array to a decimal string (for snarkjs input).
fn bytes_to_decimal(bytes: &[u8; 32]) -> String {
    // Interpret as big-endian unsigned integer
    let mut result = vec![0u8]; // Start with 0
    for &byte in bytes.iter() {
        // Multiply result by 256
        let mut carry = 0u16;
        for digit in result.iter_mut().rev() {
            let prod = (*digit as u16) * 256 + carry;
            *digit = (prod % 10) as u8;
            carry = prod / 10;
        }
        while carry > 0 {
            result.insert(0, (carry % 10) as u8);
            carry /= 10;
        }

        // Add byte
        let mut carry = byte as u16;
        for digit in result.iter_mut().rev() {
            let sum = (*digit as u16) + carry;
            *digit = (sum % 10) as u8;
            carry = sum / 10;
        }
        while carry > 0 {
            result.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }

    if result.is_empty() || result.iter().all(|&d| d == 0) {
        "0".to_string()
    } else {
        result.iter().map(|d| (b'0' + d) as char).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bytes_to_decimal_zero() {
        assert_eq!(bytes_to_decimal(&[0u8; 32]), "0");
    }

    #[test]
    fn test_bytes_to_decimal_one() {
        let mut bytes = [0u8; 32];
        bytes[31] = 1;
        assert_eq!(bytes_to_decimal(&bytes), "1");
    }

    #[test]
    fn test_bytes_to_decimal_256() {
        let mut bytes = [0u8; 32];
        bytes[30] = 1; // 256
        assert_eq!(bytes_to_decimal(&bytes), "256");
    }
}
