# Threat Model

## Scope

This document describes the security properties, trust assumptions, and known limitations of the Holanc privacy protocol.

## Trust Assumptions

### 1. Trusted Setup (Groth16)

Groth16 proofs require a structured reference string (SRS) generated via a trusted setup ceremony:

- **Phase 1 (Powers of Tau)**: Universal ceremony shared across all circuits. Secure as long as at least one participant is honest and destroys their toxic waste.
- **Phase 2 (Circuit-specific)**: Per-circuit contribution. Same 1-of-N honesty assumption.

**Mitigation**: Future migration path to PLONK/KZG (universal setup) or STARKs (transparent setup). The verifier program abstraction supports swappable proof systems.

### 2. BN254 Security

BN254 (alt-bn128) provides approximately 100 bits of security against discrete log attacks. While below the 128-bit standard, it is:

- The only pairing-friendly curve with native Solana syscall support
- Widely used in production (Tornado Cash, Zcash Sapling, Ethereum precompiles)
- Adequate for the current threat landscape

**Mitigation**: Monitor cryptanalytic advances. When Solana adds BLS12-381 syscalls, migration provides ~128-bit security.

### 3. Poseidon Hash Function

Poseidon is relatively new compared to SHA-256 or BLAKE. Its security relies on algebraic hardness assumptions specific to arithmetic circuits over prime fields.

**Mitigation**: Use conservative parameterization (8 full rounds + partial rounds per the original paper's security analysis). Poseidon has undergone multiple academic audits.

### 4. RPC / Validator Trust

Users trust their RPC provider to:

- Honestly report Merkle roots and transaction confirmations
- Not censor transactions

**Mitigation**: Users can verify roots against multiple RPCs. The relayer service serves as an intermediary, allowing users to avoid direct RPC interaction.

## Adversary Models

### Passive Network Observer

**Capabilities**: Observes all network traffic (IP addresses, timing, payload sizes).

| Attack Vector                 | Mitigation                                                |
| ----------------------------- | --------------------------------------------------------- |
| Link IP to deposit/withdrawal | Relayer service; user never interacts directly with RPC   |
| Timing correlation            | Jitter scheduling (truncated exponential delay, 200ms-5s) |
| Payload size analysis         | Fixed 2048-byte envelopes for all note types              |
| Batch size analysis           | Dummy transaction padding in relay batches                |

**Residual risk**: A global passive adversary with access to both the relayer's incoming HTTP traffic and outgoing RPC traffic could correlate requests. Tor/VPN at the client level provides additional layer.

### On-Chain Analyst

**Capabilities**: Reads all on-chain data (program logs, account state).

| Attack Vector                 | Mitigation                                                      |
| ----------------------------- | --------------------------------------------------------------- |
| Link deposits to withdrawals  | ZK proofs reveal only nullifiers and commitments, not the link  |
| Denomination fingerprinting   | Fixed denomination tiers (planned) or sufficient pool liquidity |
| Deposit/withdraw timing       | Encourage time separation; relayer jitter                       |
| Unique amount deanonymization | Encourage standard amounts; change notes                        |

**Residual risk**: Small anonymity set (few depositors) weakens privacy. Protocol privacy improves with usage.

### Malicious Relayer

**Capabilities**: Controls the relayer service.

| Attack Vector            | Mitigation                                                     |
| ------------------------ | -------------------------------------------------------------- |
| Censor transactions      | Users can bypass relayer and submit directly                   |
| Log transaction metadata | Relayer never sees plaintext notes (only signed transactions)  |
| Front-run withdrawals    | Transactions are pre-signed by the user; relayer cannot modify |
| Reorder for profit       | Privacy transactions have no MEV value (encrypted amounts)     |

### Compromised Spending Key

**Impact**: Full loss of funds for all notes owned by that key.

**Mitigation**:

- BIP-39 mnemonic with strong entropy
- HKDF key derivation with domain separation
- Future: hardware wallet integration for key storage

### Compromised Viewing Key

**Impact**: Loss of privacy (attacker can see all note amounts and counterparties) but NOT loss of funds.

**Mitigation**: Viewing keys are derived separately from spending keys. Sharing a viewing key (e.g., for compliance) does not enable spending.

## Circuit Soundness

### Value Conservation

The transfer and withdraw circuits enforce:

```
sum(input_values) == sum(output_values) [+ exit_value]
```

All values are constrained to 64 bits via `Num2Bits(64)` range checks, preventing underflow/overflow attacks using the BN254 field modulus.

### Nullifier Uniqueness

Nullifiers are deterministically derived from `(spending_key, commitment)`. The on-chain bitmap provides O(1) double-spend detection. A valid Groth16 proof guarantees the nullifier was correctly derived from a note that exists in the Merkle tree.

### Merkle Inclusion

Each input note must have a valid Merkle path to one of the 100 recent historical roots. The root is a public input, verified by the on-chain program before accepting the proof.

## Known Limitations

1. **Anonymity set size**: Privacy depends on pool usage. A pool with few participants provides weak anonymity.
2. **Trusted setup**: Groth16 requires honest ceremony participants. A compromised setup enables proof forgery.
3. **No forward secrecy**: If a spending key is later compromised, all historical transactions for that key are retroactively deanonymizable (if encrypted notes were recorded).
4. **Single-asset pools**: Current design has one pool per asset type. Cross-asset private swaps are not yet supported.
5. **Fixed circuit sizes**: Transfer circuits support exactly 2 inputs and 2 outputs. Variable-size circuits are planned for Phase 2.
6. **BN254 security margin**: ~100-bit security, below the modern 128-bit standard.

## Dual-Hash Merkle Architecture

Holanc uses two parallel Merkle trees over the same set of commitments:

| Property    | On-chain tree       | Circuit tree        |
| ----------- | ------------------- | ------------------- |
| Hash        | SHA-256             | Poseidon            |
| Purpose     | Cheap root tracking | ZK-friendly proofs  |
| CU cost     | ~100 CU (syscall)   | ~6k constraints     |
| Updated by  | Pool program        | Client / relayer    |

### Invariant

For every leaf index _i_, the SHA-256 tree and the Poseidon tree contain the **same** commitment bytes. The on-chain program stores only the SHA-256 root; the Poseidon root is a public input inside the ZK proof.

### Threat Analysis

| Scenario | Impact | Detection | Mitigation |
| --- | --- | --- | --- |
| Client computes wrong Poseidon path | Proof verification fails (invalid root) | Immediate: groth16 verify rejects | None needed — soundness enforced by verifier |
| Relayer submits stale Poseidon root | Proof passes but root not in `root_history` ring buffer | Immediate: `update_root` checks SHA-256 root freshness | Pool rejects if SHA-256 root mismatch |
| Indexer misses a commitment event | Client builds Poseidon tree with wrong leaves → root mismatch | On next proof attempt | Re-scan from last confirmed checkpoint (crash-safe scanner) |
| SHA-256 tree diverges from Poseidon tree | Funds locked — valid Poseidon proof rejected by SHA-256 check | Monitoring: compare local Poseidon root with on-chain SHA-256 root | Emergency admin `pause`; off-chain tree resync |
| Malicious program upgrade changes SHA-256 logic | Tree corruption | Governance / multisig review | Anchor upgrade authority; immutable after audit |

### Why Two Trees?

A single-hash approach would require either:

- **Poseidon on-chain**: ~6k constraints per hash → ~120k CU per 20-level insert. Exceeds Solana's 200k CU budget for complex transactions.
- **SHA-256 in circuit**: ~25k constraints per hash → ~500k constraints per 20-level Merkle path. Proof generation time ~30s+ and verification cost prohibitive.

The dual-tree design keeps on-chain operations cheap (SHA-256 syscall) while ZK proofs remain efficient (Poseidon). The trade-off is implementation complexity and the requirement that both trees stay in sync — enforced by the invariant above.

## Compliance Considerations

The viewing key mechanism enables selective disclosure:

- Users can share their viewing key with auditors to prove transaction history
- Future: ZK proofs of compliance (e.g., "total balance < threshold") without revealing exact amounts
- The protocol does not implement mandatory backdoors or escrow keys
