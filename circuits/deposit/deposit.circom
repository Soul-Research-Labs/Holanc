pragma circom 2.1.0;

include "../lib/common.circom";

/// Deposit circuit: proves knowledge of a valid note commitment
/// without revealing the note contents.
///
/// This is a simplified proof used during deposit to ensure the commitment
/// is well-formed (i.e., the depositor actually knows the preimage).
///
/// Public inputs:
///   - commitment (the note commitment being deposited)
///   - value (the deposit amount, public for matching with token transfer)
///
/// Private inputs:
///   - owner, asset_id, blinding
template Deposit() {
    // Public
    signal input commitment;
    signal input value;

    // Private
    signal input owner;
    signal input asset_id;
    signal input blinding;

    // Compute commitment and verify it matches
    component cm = NoteCommitment();
    cm.owner <== owner;
    cm.value <== value;
    cm.asset_id <== asset_id;
    cm.blinding <== blinding;
    cm.commitment === commitment;

    // Range check on value
    component range = RangeCheck(64);
    range.value <== value;
}

component main {public [commitment, value]} = Deposit();
