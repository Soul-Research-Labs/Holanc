pragma circom 2.1.0;

include "../lib/common.circom";

/// Wealth proof circuit.
///
/// Proves "the sum of my shielded note values is at least `threshold`"
/// without revealing the exact balance, the number of notes, or which
/// notes are owned.
///
/// Supports up to 8 input notes. Unused slots are filled with zero-value
/// dummy notes (they pass Merkle inclusion against the zero subtree).
///
/// Public inputs:
///   - merkle_root
///   - threshold        (minimum balance to prove)
///   - owner_commitment (Poseidon(spending_key) — proves ownership)
///
/// Private inputs:
///   - spending_key
///   - note data × 8 (value, asset_id, blinding, Merkle path)
template WealthProof(tree_depth, max_notes) {
    // ---------------------------------------------------------------
    // Public inputs
    // ---------------------------------------------------------------
    signal input merkle_root;
    signal input threshold;
    signal input owner_commitment;

    // ---------------------------------------------------------------
    // Private inputs
    // ---------------------------------------------------------------
    signal input spending_key;

    signal input note_value[max_notes];
    signal input note_asset_id[max_notes];
    signal input note_blinding[max_notes];
    signal input note_path_elements[max_notes][tree_depth];
    signal input note_path_indices[max_notes][tree_depth];

    // ---------------------------------------------------------------
    // Step 1: Verify ownership — Poseidon(spending_key) == owner_commitment
    // ---------------------------------------------------------------
    component owner_hash = Poseidon(1);
    owner_hash.inputs[0] <== spending_key;
    owner_hash.out === owner_commitment;

    // ---------------------------------------------------------------
    // Step 2: For each note, verify inclusion and ownership
    // ---------------------------------------------------------------
    component note_cm[max_notes];
    component merkle_proof[max_notes];
    signal owner;
    owner <== owner_hash.out;

    for (var i = 0; i < max_notes; i++) {
        // Compute commitment
        note_cm[i] = NoteCommitment();
        note_cm[i].owner <== owner;
        note_cm[i].value <== note_value[i];
        note_cm[i].asset_id <== note_asset_id[i];
        note_cm[i].blinding <== note_blinding[i];

        // Verify Merkle inclusion
        merkle_proof[i] = MerkleProof(tree_depth);
        merkle_proof[i].leaf <== note_cm[i].commitment;
        for (var j = 0; j < tree_depth; j++) {
            merkle_proof[i].path_elements[j] <== note_path_elements[i][j];
            merkle_proof[i].path_indices[j] <== note_path_indices[i][j];
        }
        merkle_proof[i].root === merkle_root;
    }

    // ---------------------------------------------------------------
    // Step 3: Sum all note values
    // ---------------------------------------------------------------
    signal partial_sum[max_notes];
    partial_sum[0] <== note_value[0];
    for (var i = 1; i < max_notes; i++) {
        partial_sum[i] <== partial_sum[i - 1] + note_value[i];
    }
    signal total_balance;
    total_balance <== partial_sum[max_notes - 1];

    // ---------------------------------------------------------------
    // Step 4: Range checks on all values
    // ---------------------------------------------------------------
    component range[max_notes];
    for (var i = 0; i < max_notes; i++) {
        range[i] = RangeCheck(64);
        range[i].value <== note_value[i];
    }

    // ---------------------------------------------------------------
    // Step 5: Prove total_balance >= threshold
    //   total_balance - threshold >= 0 (i.e., fits in 64 bits)
    // ---------------------------------------------------------------
    signal diff;
    diff <== total_balance - threshold;

    component range_diff = RangeCheck(64);
    range_diff.value <== diff;
}

// 8 notes, tree depth 20
component main {public [merkle_root, threshold, owner_commitment]} = WealthProof(20, 8);
