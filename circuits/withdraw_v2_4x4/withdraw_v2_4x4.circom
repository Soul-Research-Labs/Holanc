pragma circom 2.1.0;

include "../lib/common.circom";

/// Variable I/O withdraw circuit with V2 domain-separated nullifiers.
///
/// Combines WithdrawN (variable inputs/outputs + exit_value) with NullifierV2
/// (chain_id/app_id domain separation) for cross-chain privacy withdrawals.
///
/// Value conservation: sum(effective_in) == sum(effective_out) + exit_value + fee
///
/// Public inputs:
///   - merkle_root
///   - nullifiers[n_in]
///   - output_commitments[n_out]
///   - exit_value
///   - fee
///   - chain_id
///   - app_id
template WithdrawN_V2(n_in, n_out, tree_depth) {
    // ── Public inputs ──────────────────────────────────────────────
    signal input merkle_root;
    signal input nullifiers[n_in];
    signal input output_commitments[n_out];
    signal input exit_value;
    signal input fee;
    signal input chain_id;
    signal input app_id;

    // ── Private inputs — input notes ───────────────────────────────
    signal input spending_key;
    signal input has_input[n_in];

    signal input in_owner[n_in];
    signal input in_value[n_in];
    signal input in_asset_id[n_in];
    signal input in_blinding[n_in];

    signal input merkle_path_elements[n_in][tree_depth];
    signal input merkle_path_indices[n_in][tree_depth];

    // ── Private inputs — output notes ──────────────────────────────
    signal input has_output[n_out];

    signal input out_owner[n_out];
    signal input out_value[n_out];
    signal input out_asset_id[n_out];
    signal input out_blinding[n_out];

    // ── Boolean-constrain selectors ────────────────────────────────
    for (var i = 0; i < n_in; i++) {
        has_input[i] * (has_input[i] - 1) === 0;
    }
    for (var i = 0; i < n_out; i++) {
        has_output[i] * (has_output[i] - 1) === 0;
    }

    // ── Step 1: Input notes with V2 nullifiers ─────────────────────
    component in_cm[n_in];
    component in_nf[n_in];
    component merkle_proof[n_in];
    signal effective_in_value[n_in];

    for (var i = 0; i < n_in; i++) {
        effective_in_value[i] <== in_value[i] * has_input[i];

        in_cm[i] = NoteCommitment();
        in_cm[i].owner <== in_owner[i];
        in_cm[i].value <== in_value[i];
        in_cm[i].asset_id <== in_asset_id[i];
        in_cm[i].blinding <== in_blinding[i];

        // V2 nullifier: domain-separated with chain_id and app_id
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

    // ── Step 2: Output commitments ─────────────────────────────────
    component out_cm[n_out];
    signal effective_out_value[n_out];

    for (var i = 0; i < n_out; i++) {
        effective_out_value[i] <== out_value[i] * has_output[i];

        out_cm[i] = NoteCommitment();
        out_cm[i].owner <== out_owner[i];
        out_cm[i].value <== out_value[i];
        out_cm[i].asset_id <== out_asset_id[i];
        out_cm[i].blinding <== out_blinding[i];

        out_cm[i].commitment === output_commitments[i];
    }

    // ── Step 3: Value conservation with exit ───────────────────────
    signal running_in[n_in + 1];
    running_in[0] <== 0;
    for (var i = 0; i < n_in; i++) {
        running_in[i + 1] <== running_in[i] + effective_in_value[i];
    }

    signal running_out[n_out + 1];
    running_out[0] <== 0;
    for (var i = 0; i < n_out; i++) {
        running_out[i + 1] <== running_out[i] + effective_out_value[i];
    }

    running_in[n_in] === running_out[n_out] + exit_value + fee;

    // ── Step 4: Range checks ───────────────────────────────────────
    component range_in[n_in];
    component range_out[n_out];
    component range_exit;
    component range_fee;

    for (var i = 0; i < n_in; i++) {
        range_in[i] = RangeCheck(64);
        range_in[i].value <== effective_in_value[i];
    }
    for (var i = 0; i < n_out; i++) {
        range_out[i] = RangeCheck(64);
        range_out[i].value <== effective_out_value[i];
    }
    range_exit = RangeCheck(64);
    range_exit.value <== exit_value;
    range_fee = RangeCheck(64);
    range_fee.value <== fee;

    // ── Step 5: Asset ID consistency ───────────────────────────────
    for (var i = 1; i < n_in; i++) {
        signal diff_in_asset[i];
        diff_in_asset[i - 1] <== (in_asset_id[i] - in_asset_id[0]) * has_input[i];
        diff_in_asset[i - 1] === 0;
    }
    for (var i = 0; i < n_out; i++) {
        signal diff_out_asset[i];
        diff_out_asset[i] <== (out_asset_id[i] - in_asset_id[0]) * has_output[i];
        diff_out_asset[i] === 0;
    }
}

component main {public [merkle_root, nullifiers, output_commitments, exit_value, fee, chain_id, app_id]} = WithdrawN_V2(4, 4, 20);
