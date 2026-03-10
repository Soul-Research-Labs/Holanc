//! Circuit input preparation for snarkjs proving.

use crate::{
    DepositParams, ProverError, StealthTransferParams, TransferParams, WealthProofParams,
    WithdrawParams,
};
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

/// Build the JSON input for the deposit circuit.
pub fn build_deposit_input(params: &DepositParams) -> Result<Value, ProverError> {
    Ok(json!({
        "owner": bytes_to_decimal(&params.owner),
        "value": params.value.to_string(),
        "asset_id": bytes_to_decimal(&params.asset_id),
        "blinding": bytes_to_decimal(&params.blinding),
    }))
}

/// Build the JSON input for the stealth transfer circuit.
pub fn build_stealth_transfer_input(
    params: &StealthTransferParams,
) -> Result<Value, ProverError> {
    let mut base = build_transfer_input(&params.transfer)?;
    let obj = base.as_object_mut().unwrap();
    obj.insert(
        "ephemeral_key".to_string(),
        json!(bytes_to_decimal(&params.ephemeral_key)),
    );
    obj.insert(
        "recipient_spending_pubkey".to_string(),
        json!(bytes_to_decimal(&params.recipient_spending_pubkey)),
    );
    Ok(base)
}

/// Build the JSON input for the wealth proof circuit.
pub fn build_wealth_proof_input(params: &WealthProofParams) -> Result<Value, ProverError> {
    const MAX_NOTES: usize = 8;
    let zero = [0u8; 32];

    let mut note_values = Vec::with_capacity(MAX_NOTES);
    let mut note_blindings = Vec::with_capacity(MAX_NOTES);
    let mut note_asset_ids = Vec::with_capacity(MAX_NOTES);
    let mut has_note = Vec::with_capacity(MAX_NOTES);
    let mut merkle_path_elements = Vec::with_capacity(MAX_NOTES);
    let mut merkle_path_indices = Vec::with_capacity(MAX_NOTES);

    for i in 0..MAX_NOTES {
        if i < params.input_notes.len() {
            let note = &params.input_notes[i];
            note_values.push(note.value.to_string());
            note_blindings.push(bytes_to_decimal(&note.blinding));
            note_asset_ids.push(bytes_to_decimal(&note.asset_id));
            has_note.push("1".to_string());
            if i < params.input_proofs.len() {
                merkle_path_elements.push(
                    params.input_proofs[i]
                        .path_elements
                        .iter()
                        .map(|e| bytes_to_decimal(e))
                        .collect::<Vec<_>>(),
                );
                merkle_path_indices.push(
                    params.input_proofs[i]
                        .path_indices
                        .iter()
                        .map(|idx| idx.to_string())
                        .collect::<Vec<_>>(),
                );
            } else {
                merkle_path_elements.push(vec!["0".to_string(); 20]);
                merkle_path_indices.push(vec!["0".to_string(); 20]);
            }
        } else {
            note_values.push("0".to_string());
            note_blindings.push(bytes_to_decimal(&zero));
            note_asset_ids.push(bytes_to_decimal(&zero));
            has_note.push("0".to_string());
            merkle_path_elements.push(vec!["0".to_string(); 20]);
            merkle_path_indices.push(vec!["0".to_string(); 20]);
        }
    }

    Ok(json!({
        "spending_key": bytes_to_decimal(&params.spending_key),
        "note_value": note_values,
        "note_blinding": note_blindings,
        "note_asset_id": note_asset_ids,
        "has_note": has_note,
        "merkle_path_elements": merkle_path_elements,
        "merkle_path_indices": merkle_path_indices,
        "threshold": params.threshold.to_string(),
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
