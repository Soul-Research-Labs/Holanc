pragma circom 2.1.0;

include "../lib/common.circom";

/// Transfer circuit with V2 domain-separated nullifiers.
///
/// Identical to the base transfer circuit but uses NullifierV2 instead of V1:
///   nullifier = Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))
///
/// This enables cross-chain privacy: the same note produces different
/// nullifiers on different chains, preventing cross-chain linkage while
/// still allowing cross-chain double-spend detection via epoch roots.
///
/// Public inputs:
///   - merkle_root
///   - nullifiers[2]
///   - output_commitments[2]
///   - fee
///   - chain_id
///   - app_id
template TransferV2(tree_depth) {
    // ---------------------------------------------------------------
    // Public inputs
    // ---------------------------------------------------------------
    signal input merkle_root;
    signal input nullifiers[2];
    signal input output_commitments[2];
    signal input fee;
    signal input chain_id;
    signal input app_id;

    // ---------------------------------------------------------------
    // Private inputs — input notes
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
    // Step 1: Verify input notes + V2 nullifiers + Merkle inclusion
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

        // V2 nullifier with domain separation
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

component main {public [merkle_root, nullifiers, output_commitments, fee, chain_id, app_id]} = TransferV2(20);
