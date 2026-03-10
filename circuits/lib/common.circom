pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

/// Compute a note commitment: Poseidon(owner, value, asset_id, blinding)
/// Matches the off-chain commitment in holanc-primitives.
template NoteCommitment() {
    signal input owner;
    signal input value;
    signal input asset_id;
    signal input blinding;
    signal output commitment;

    component hasher = Poseidon(4);
    hasher.inputs[0] <== owner;
    hasher.inputs[1] <== value;
    hasher.inputs[2] <== asset_id;
    hasher.inputs[3] <== blinding;
    commitment <== hasher.out;
}

/// Derive a V1 nullifier: Poseidon(spending_key, commitment)
template NullifierV1() {
    signal input spending_key;
    signal input commitment;
    signal output nullifier;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== spending_key;
    hasher.inputs[1] <== commitment;
    nullifier <== hasher.out;
}

/// Derive a V2 nullifier (domain-separated):
///   inner = Poseidon(spending_key, commitment)
///   domain = Poseidon(chain_id, app_id)
///   nullifier = Poseidon(inner, domain)
template NullifierV2() {
    signal input spending_key;
    signal input commitment;
    signal input chain_id;
    signal input app_id;
    signal output nullifier;

    component inner_hash = Poseidon(2);
    inner_hash.inputs[0] <== spending_key;
    inner_hash.inputs[1] <== commitment;

    component domain_hash = Poseidon(2);
    domain_hash.inputs[0] <== chain_id;
    domain_hash.inputs[1] <== app_id;

    component final_hash = Poseidon(2);
    final_hash.inputs[0] <== inner_hash.out;
    final_hash.inputs[1] <== domain_hash.out;
    nullifier <== final_hash.out;
}

/// Verify a Merkle inclusion proof (Poseidon-based, parameterized depth).
template MerkleProof(levels) {
    signal input leaf;
    signal input path_elements[levels];
    signal input path_indices[levels]; // 0 = left, 1 = right
    signal output root;

    component hashers[levels];
    signal intermediate[levels + 1];
    intermediate[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);

        // If path_indices[i] == 0, leaf is on the left:  H(intermediate, path_element)
        // If path_indices[i] == 1, leaf is on the right: H(path_element, intermediate)
        signal left;
        signal right;

        left <== intermediate[i] + path_indices[i] * (path_elements[i] - intermediate[i]);
        right <== path_elements[i] + path_indices[i] * (intermediate[i] - path_elements[i]);

        hashers[i].inputs[0] <== left;
        hashers[i].inputs[1] <== right;
        intermediate[i + 1] <== hashers[i].out;
    }

    root <== intermediate[levels];
}

/// Range check: ensure 0 <= value < 2^n using bit decomposition.
template RangeCheck(n) {
    signal input value;
    signal bits[n];

    var sum = 0;
    for (var i = 0; i < n; i++) {
        bits[i] <-- (value >> i) & 1;
        bits[i] * (bits[i] - 1) === 0; // Each bit is 0 or 1
        sum += bits[i] * (1 << i);
    }
    value === sum;
}
