pragma circom 2.1.0;

include "../lib/common.circom";

/// Variable I/O transfer circuit (n_in-in, n_out-out).
///
/// Generalizes the 2-in-2-out transfer circuit to support variable input/output
/// counts. Each note can be active or inactive (for padding) using a `has_input`
/// / `has_output` selector — inactive notes contribute zero value.
///
/// Public inputs:
///   - merkle_root
///   - nullifiers[n_in]
///   - output_commitments[n_out]
///   - fee
///
/// Private inputs:
///   - spending_key
///   - has_input[n_in]             — 0/1 selector for active inputs
///   - input notes × n_in
///   - Merkle paths × n_in
///   - has_output[n_out]           — 0/1 selector for active outputs
///   - output notes × n_out
template TransferN(n_in, n_out, tree_depth) {
    // ── Public inputs ──────────────────────────────────────────────
    signal input merkle_root;
    signal input nullifiers[n_in];
    signal input output_commitments[n_out];
    signal input fee;

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

    // ── Step 1: Input notes — commitment, nullifier, Merkle proof ──
    component in_cm[n_in];
    component in_nf[n_in];
    component merkle_proof[n_in];
    signal effective_in_value[n_in];

    for (var i = 0; i < n_in; i++) {
        // Effective value: only active inputs contribute
        effective_in_value[i] <== in_value[i] * has_input[i];

        // Compute commitment
        in_cm[i] = NoteCommitment();
        in_cm[i].owner <== in_owner[i];
        in_cm[i].value <== in_value[i];
        in_cm[i].asset_id <== in_asset_id[i];
        in_cm[i].blinding <== in_blinding[i];

        // Derive nullifier
        in_nf[i] = NullifierV1();
        in_nf[i].spending_key <== spending_key;
        in_nf[i].commitment <== in_cm[i].commitment;

        // Constrain nullifier matches public input
        in_nf[i].nullifier === nullifiers[i];

        // Merkle inclusion proof
        merkle_proof[i] = MerkleProof(tree_depth);
        merkle_proof[i].leaf <== in_cm[i].commitment;
        for (var j = 0; j < tree_depth; j++) {
            merkle_proof[i].path_elements[j] <== merkle_path_elements[i][j];
            merkle_proof[i].path_indices[j] <== merkle_path_indices[i][j];
        }

        // Active inputs must prove Merkle inclusion against the root.
        // Inactive inputs (has_input==0) have dummy commitments with valid
        // Merkle paths (e.g. a zero leaf); we still constrain the root so
        // the prover cannot inject arbitrary values. The value conservation
        // constraint ensures inactive notes contribute 0 value.
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

    // ── Step 3: Value conservation ─────────────────────────────────
    //   sum(effective_in) == sum(effective_out) + fee
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

    running_in[n_in] === running_out[n_out] + fee;

    // ── Step 4: Range checks (64-bit) ──────────────────────────────
    component range_in[n_in];
    component range_out[n_out];
    component range_fee;

    for (var i = 0; i < n_in; i++) {
        range_in[i] = RangeCheck(64);
        range_in[i].value <== effective_in_value[i];
    }
    for (var i = 0; i < n_out; i++) {
        range_out[i] = RangeCheck(64);
        range_out[i].value <== effective_out_value[i];
    }

    range_fee = RangeCheck(64);
    range_fee.value <== fee;

    // ── Step 5: Asset ID consistency ───────────────────────────────
    //   Use the first active input's asset ID as reference.
    //   All active notes must share the same asset ID.
    //   (In practice, the pool is single-asset so this is always satisfied.)
    for (var i = 1; i < n_in; i++) {
        // active inputs must match first input's asset_id
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

// ── 4-in-4-out variant ─────────────────────────────────────────────
component main {public [merkle_root, nullifiers, output_commitments, fee]} = TransferN(4, 4, 20);
