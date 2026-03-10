# Cross-Chain Privacy

## Overview

Holanc supports privacy across multiple SVM-compatible chains: Solana, Eclipse, Sonic, and other SVM rollups. The cross-chain design ensures that:

1. Each chain maintains its own independent privacy pool
2. Notes cannot be double-spent across chains
3. Privacy sets can be unified through bridge adapters (Phase 2)

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Solana      │    │   Eclipse     │    │   Sonic       │
│              │    │              │    │              │
│ ┌──────────┐ │    │ ┌──────────┐ │    │ ┌──────────┐ │
│ │ Pool     │ │    │ │ Pool     │ │    │ │ Pool     │ │
│ │ Verifier │ │    │ │ Verifier │ │    │ │ Verifier │ │
│ │ Nullifier│ │    │ │ Nullifier│ │    │ │ Nullifier│ │
│ └────┬─────┘ │    │ └────┬─────┘ │    │ └────┬─────┘ │
│      │       │    │      │       │    │      │       │
│ ┌────▼─────┐ │    │ ┌────▼─────┐ │    │ ┌────▼─────┐ │
│ │ Epoch    │ │    │ │ Epoch    │ │    │ │ Epoch    │ │
│ │ Manager  │ │    │ │ Manager  │ │    │ │ Manager  │ │
│ └────┬─────┘ │    │ └────┬─────┘ │    │ └────┬─────┘ │
└──────┼───────┘    └──────┼───────┘    └──────┼───────┘
       │                   │                   │
       └───────────┬───────┘───────────────────┘
                   │
           ┌───────▼────────┐
           │   Wormhole     │
           │   Bridge       │
           │  (Epoch Roots) │
           └────────────────┘
```

## Domain-Separated Nullifiers

### Problem

If nullifiers are derived solely from `Poseidon(spending_key, commitment)`, the same note deposited on Solana and Eclipse would produce the same nullifier on both chains. An observer could link activity across chains by matching nullifiers.

### Solution (V2 Nullifiers)

```
chain_domain = Poseidon(chain_id, app_id)
nullifier = Poseidon(Poseidon(spending_key, commitment), chain_domain)
```

| Chain   | chain_id | Domain Hash           |
| ------- | -------- | --------------------- |
| Solana  | 1        | `Poseidon(1, app_id)` |
| Eclipse | 2        | `Poseidon(2, app_id)` |
| Sonic   | 3        | `Poseidon(3, app_id)` |

The same spending_key + commitment now produces distinct nullifiers per chain, preventing cross-chain linkage.

### On-Chain Implementation

The `holanc-nullifier` program supports V2 nullifiers:

```rust
pub fn register_nullifier_v2(
    ctx: Context<RegisterNullifierV2>,
    nullifier: [u8; 32],
    chain_id: u64,
    app_id: u64,
) -> Result<()> { ... }
```

V2 nullifiers are stored in a separate `NullifierRegistryV2` PDA seeded by `[b"nullifier_v2", &chain_id.to_le_bytes(), &app_id.to_le_bytes()]`.

## Epoch-Based Synchronization

### Epoch Lifecycle

1. **Accumulation**: Nullifiers are registered on-chain during the current epoch (e.g., epoch duration = 432,000 slots ≈ 2 days on Solana)
2. **Finalization**: At epoch boundary, the epoch's nullifier Merkle root is computed and stored
3. **Publication**: The finalized epoch root is published as a Wormhole VAA (Verified Action Approval)
4. **Verification**: Other chains receive the VAA and store the epoch root, enabling cross-chain nullifier verification

### Epoch Root Computation

```
epoch_root = MerkleRoot(nullifier_0, nullifier_1, ..., nullifier_n)
```

Stored on-chain in the `EpochState` PDA:

```rust
pub struct EpochState {
    pub current_epoch: u64,
    pub epoch_start_slot: u64,
    pub nullifier_count: u64,
    pub epoch_root: [u8; 32],
    pub finalized: bool,
}
```

### Cross-Chain Verification

When a user attempts to spend a note on Eclipse that was nullified on Solana:

1. Eclipse's nullifier program receives the Solana epoch root via Wormhole
2. The user provides a Merkle proof that the nullifier is included in Solana's epoch root
3. Eclipse rejects the spend, preventing cross-chain double-spending

## Bridge Adapter (Phase 2)

The `holanc-bridge` program (planned) will enable true cross-chain private transfers:

1. **Shield on Chain A**: User deposits and creates a shielded note on Solana
2. **Bridge commitment**: A Wormhole message carries the commitment (not the note) cross-chain
3. **Mirror on Chain B**: Eclipse's pool accepts the bridged commitment into its Merkle tree
4. **Spend on Chain B**: User proves knowledge of the note against Eclipse's tree

This preserves privacy because only the commitment hash crosses the bridge — no amounts, owners, or transaction links are revealed.

### Security Considerations

- Bridge messages are authenticated via Wormhole's guardian set (13/19 multisig)
- Bridged commitments are tagged with a source chain identifier to prevent replay
- Withdrawal on the source chain requires nullification on both source and destination chains
- Rate limiting prevents bridge flooding
