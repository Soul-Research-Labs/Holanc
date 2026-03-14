pragma circom 2.1.0;

include "../lib/common.circom";

/// Stealth transfer circuit with cross-chain V2 nullifiers (2-in-2-out).
///
/// Identical to StealthTransfer but uses NullifierV2 (domain-separated by
/// chain_id + app_id) instead of NullifierV1, enabling the same note to
/// be safely used across multiple SVM chains without nullifier collision.
///
/// Public inputs:
///   - merkle_root
///   - nullifiers[2]
///   - output_commitments[2]
///   - fee
///   - ephemeral_pubkey
///   - chain_id
///   - app_id
template StealthTransferV2(tree_depth) {
    // ---------------------------------------------------------------
    // Public inputs
    // ---------------------------------------------------------------
    signal input merkle_root;
    signal input nullifiers[2];
    signal input output_commitments[2];
    signal input fee;
    signal input ephemeral_pubkey;
    signal input chain_id;
    signal input app_id;

    // ---------------------------------------------------------------
    // Private inputs — stealth derivation
    // ---------------------------------------------------------------
    signal input ephemeral_key;
    signal input recipient_spending_pubkey;

    // ---------------------------------------------------------------
    // Private inputs — spending
    // ---------------------------------------------------------------
    signal input spending_key;

    signal input in_owner[2];
    signal input in_value[2];
    signal input in_asset_id[2];
    signal input in_blinding[2];

    signal input merkle_path_elements[2][tree_depth];
    signal input merkle_path_indices[2][tree_depth];

    // ---------------------------------------------------------------
    // Private inputs — output notes
    // ---------------------------------------------------------------
    signal input out_owner[2];
    signal input out_value[2];
    signal input out_asset_id[2];
    signal input out_blinding[2];

    // ---------------------------------------------------------------
    // Step 0: Verify ephemeral_pubkey derivation
    // ---------------------------------------------------------------
    component eph_pub = Poseidon(1);
    eph_pub.inputs[0] <== ephemeral_key;
    eph_pub.out === ephemeral_pubkey;

    // ---------------------------------------------------------------
    // Step 0b: Derive stealth address and verify output[0] uses it
    // ---------------------------------------------------------------
    component shared_secret = Poseidon(2);
    shared_secret.inputs[0] <== ephemeral_key;
    shared_secret.inputs[1] <== recipient_spending_pubkey;

    component stealth_owner = Poseidon(2);
    stealth_owner.inputs[0] <== recipient_spending_pubkey;
    stealth_owner.inputs[1] <== shared_secret.out;

    out_owner[0] === stealth_owner.out;

    // ---------------------------------------------------------------
    // Step 1: Verify input note commitments + nullifiers (V2) + Merkle
    // ---------------------------------------------------------------
    component in_cm[2];
    component in_nf[2];
    component merkle_proof[2];

    for (var i = 0; i < 2; i++) {
        in_cm[i] = NoteCommitment();
        in_cm[i].owner <== in_owner[i];
        in_cm[i].value <== in_value[i];
        in_cm[i].asset_id <== in_asset_id[i];
        in_cm[i].blinding <== in_blinding[i];

        in_nf[i] = NullifierV2();
        in_nf[i].spending_key <== spending_key;
        in_nf[i].commitment <== in_cm[i].commitment;
        in_nf[i].chain_id <== chain_id;
        in_nf[i].app_id <== app_id;
        in_nf[i].nullifier === nullifiers[i];

        merkle_proof[i] = MerkleProof(tree_depth);
        merkle_proof[i].leaf <== in_cm[i].commitment;
        for (var j = 0; j < tree_depth; j++) {
            merkle_proof[i].path_elements[j] <== merkle_path_elements[i][j];
            merkle_proof[i].path_indices[j] <== merkle_path_indices[i][j];
        }
        merkle_proof[i].root === merkle_root;
    }

    // ---------------------------------------------------------------
    // Step 2: Verify output commitments
    // ---------------------------------------------------------------
    component out_cm[2];
    for (var i = 0; i < 2; i++) {
        out_cm[i] = NoteCommitment();
        out_cm[i].owner <== out_owner[i];
        out_cm[i].value <== out_value[i];
        out_cm[i].asset_id <== out_asset_id[i];
        out_cm[i].blinding <== out_blinding[i];
        out_cm[i].commitment === output_commitments[i];
    }

    // ---------------------------------------------------------------
    // Step 3: Value conservation
    // ---------------------------------------------------------------
    signal total_in;
    signal total_out;
    total_in <== in_value[0] + in_value[1];
    total_out <== out_value[0] + out_value[1] + fee;
    total_in === total_out;

    // ---------------------------------------------------------------
    // Step 4: Range checks
    // ---------------------------------------------------------------
    component range_in[2];
    component range_out[2];
    component range_fee;

    for (var i = 0; i < 2; i++) {
        range_in[i] = RangeCheck(64);
        range_in[i].value <== in_value[i];

        range_out[i] = RangeCheck(64);
        range_out[i].value <== out_value[i];
    }

    range_fee = RangeCheck(64);
    range_fee.value <== fee;

    // ---------------------------------------------------------------
    // Step 5: Asset ID consistency
    // ---------------------------------------------------------------
    in_asset_id[0] === in_asset_id[1];
    in_asset_id[0] === out_asset_id[0];
    in_asset_id[0] === out_asset_id[1];
}

component main {public [merkle_root, nullifiers, output_commitments, fee, ephemeral_pubkey, chain_id, app_id]} = StealthTransferV2(20);
