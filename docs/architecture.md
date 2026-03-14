# Architecture

## Overview

Holanc is a cross-chain ZK privacy protocol built natively for the Solana Virtual Machine (SVM). It combines two complementary patterns:

1. **Privacy Coprocessor** (inspired by Lumora) — shielded deposits, private transfers, and withdrawals using a UTXO-like note model with ZK proofs
2. **Cross-chain ZK Middleware** (inspired by ZAseon) — domain-separated nullifiers, epoch-based state sync, and Wormhole bridge integration for cross-SVM privacy

## System Components

### On-Chain (Solana Programs)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Solana Programs (Anchor)                             │
│                                                                               │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐                 │
│  │ holanc-pool │  │ holanc-verifier  │  │holanc-nullifier │                 │
│  │             │  │                  │  │                 │                 │
│  │ deposit()   │──│ Groth16 proof    │  │ Bitmap-based    │                 │
│  │ transfer()  │  │ verification via │  │ nullifier       │                 │
│  │ withdraw()  │──│ alt_bn128 pairing│  │ registry        │                 │
│  │             │  │ syscalls         │  │ + epoch mgmt    │                 │
│  │ Token vault │  │                  │  │                 │                 │
│  │ Root history│  │ VK storage (PDA) │  │ Domain sep. V2  │                 │
│  └─────────────┘  └──────────────────┘  └─────────────────┘                 │
│                                                                               │
│  ┌──────────────────┐  ┌─────────────────────┐                               │
│  │  holanc-bridge   │  │ holanc-compliance   │                               │
│  │                  │  │                     │                               │
│  │ Wormhole VAA     │  │ Oracle registration │                               │
│  │ epoch root sync  │  │ Viewing key discl.  │                               │
│  │ Commitment lock  │  │ ZK wealth proofs    │                               │
│  │ Foreign nullifier│  │ Attestation mgmt    │                               │
│  └──────────────────┘  └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**holanc-pool** — The core privacy pool program. Accepts deposits (SOL/SPL tokens), executes private transfers between shielded notes, and processes withdrawals back to public addresses. Maintains a commitment tree (depth 20) and a ring buffer of 100 historical Merkle roots.

**holanc-verifier** — Groth16 proof verification using Solana's native `alt_bn128` syscalls (`sol_alt_bn128_group_op` with opcodes for addition, scalar multiplication, and pairing). Stores verification keys per circuit type in PDAs. ~200-400K compute units per verification.

**holanc-nullifier** — Prevents double-spending via a bitmap-based nullifier registry with O(1) lookups. Supports epoch-based partitioning for cross-chain nullifier root synchronization. Domain-separated V2 nullifiers enable distinct nullifier spaces per chain/application.

**holanc-bridge** — Cross-chain epoch root synchronization via Wormhole VAA messages. Publishes local epoch roots for other SVM chains to consume, receives and verifies foreign epoch roots, locks/unlocks commitments for cross-chain transfers, and verifies foreign nullifier inclusion via Merkle proofs.

**holanc-compliance** — Optional compliance layer for regulated deployments. Supports oracle registration with granular permissions (view balance, view transactions, attest wealth, freeze), time/amount-bounded viewing key disclosure, and ZK wealth proof attestations with configurable expiry.

### Off-Chain

**Relayer** — HTTP service that accepts signed privacy transactions from clients, batches them with dummy padding (k-anonymity), applies randomized timing jitter, and submits to Solana. Prevents network-level timing correlation between user actions and on-chain transactions.

**Indexer** — Watches pool program logs for commitment events, persists encrypted note data to SQLite. Clients query the indexer to fetch encrypted notes, then trial-decrypt locally using their viewing key.

**SDK / CLI** — TypeScript SDK and Rust CLI for end-to-end privacy operations. Handles key management, note tracking, coin selection, circuit input preparation, and proof generation via snarkjs.

## Note Model (UTXO-like)

Each shielded note contains:

- `owner` — public key of the note owner
- `value` — token amount
- `asset_id` — token mint identifier
- `blinding` — random blinding factor for commitment hiding

The note commitment is: `Poseidon(owner, value, asset_id, blinding)`

Notes are never stored in plaintext on-chain. Only the commitment hash is appended to the Merkle tree. The note's plaintext is encrypted with the recipient's key and emitted as a program log.

## Proving System

- **Groth16 on BN254**: Constant-size proofs (2 G1 + 1 G2 = 256 bytes), fast on-chain verification
- **Circom 2.x**: Circuit definition language with circomlib templates (Poseidon, BabyJubJub)
- **snarkjs**: Client-side proof generation via WASM (browser + Node.js)
- **Trusted setup**: Powers of Tau ceremony (2^16), circuit-specific phase 2

### Verification Equation

```
e(-π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) = 1
```

Where `vk_x = IC[0] + Σ(public_input[i] · IC[i+1])` computed via alt_bn128 scalar multiplication and point addition syscalls.

## Cross-Chain Design

### Domain-Separated Nullifiers (V2)

```
nullifier = Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))
```

This ensures the same note produces different nullifiers on different chains, preventing cross-chain double-spend while allowing independent privacy sets per chain.

### Epoch-Based Synchronization

Nullifiers are grouped into time-bounded epochs. At epoch finalization, a Merkle root of all epoch nullifiers is computed and published on-chain. These roots can be transmitted cross-chain via Wormhole to enable other SVM chains to verify nullifier inclusion without replicating the full registry.

## Security Properties

1. **Unlinkability**: Deposits, transfers, and withdrawals are unlinkable — the ZK proof reveals only nullifiers and commitments, not the transaction graph
2. **Double-spend prevention**: Nullifiers are derived deterministically from the spending key and commitment, registered on-chain before token release
3. **Value conservation**: Circuit constraints enforce `sum(inputs) = sum(outputs) + fee` with 64-bit range checks
4. **Metadata resistance**: Fixed-size proof envelopes (2048 bytes), batched relay with dummy padding, timing jitter

## Dual-Root Merkle Architecture (Hash Consistency)

Holanc maintains **two parallel Merkle trees** over the same set of commitments, each using a different hash function. This is intentional and both roots are canonical within their respective contexts.

### On-Chain: SHA-256

The on-chain pool program (`holanc-pool`) builds an incremental SHA-256 Merkle tree during `deposit()`. SHA-256 is used because:

- Solana provides a native `sol_sha256` syscall at low compute cost
- Poseidon hashing on-chain is prohibitively expensive (~50K CU per hash vs ~200 CU for SHA-256)
- The on-chain SHA-256 root serves as an **integrity anchor** — it is not used for ZK proof verification

The SHA-256 root is validated in `update_root()` to ensure the caller's view of the tree is consistent with the on-chain state before accepting a new Poseidon root.

### Off-Chain / Circuits: Poseidon

The ZK circuits use Poseidon hash exclusively for Merkle inclusion proofs. Poseidon is a ZK-friendly hash — its algebraic structure over BN254's scalar field requires ~300 R1CS constraints per hash vs ~25,000 for SHA-256. The off-chain tree (in the Rust `holanc-tree` crate and TypeScript SDK) computes Poseidon roots, which are:

- Submitted to the pool via `update_root()` (verified against SHA-256 root for integrity)
- Used as public inputs in ZK proofs for inclusion verification
- Stored in the pool's root history ring buffer

### Cross-Chain Bridge: SHA-256

Foreign epoch nullifier roots arrive via Wormhole VAA and are verified using SHA-256 Merkle proofs in `verify_foreign_nullifier()`. This matches the Wormhole ecosystem convention and does not interact with the Poseidon proof circuit.

### Summary Table

| Context | Hash | Rationale |
|---------|------|-----------|
| On-chain Merkle (deposit) | SHA-256 | Low CU cost; integrity anchor |
| ZK circuits (proofs) | Poseidon | ZK-friendly (~300 R1CS constraints) |
| Root history (pool state) | Poseidon | Verified by ZK proofs |
| `update_root()` integrity check | SHA-256 | Ensures Poseidon root matches on-chain commits |
| Cross-chain nullifier proofs | SHA-256 | Wormhole ecosystem compatibility |

> **Invariant**: Every `update_root(poseidon_root, expected_sha256_root)` call verifies that `expected_sha256_root` matches the on-chain incrementally-computed SHA-256 root. This binds the two trees: any disagreement about which leaves exist causes `update_root` to fail.

## Variable I/O Circuits (4×4)

The `transfer_4x4` and `withdraw_4x4` circuits generalize the 2-in-2-out design to support up to 4 inputs and 4 outputs. Boolean selectors (`has_input[i]`, `has_output[j]`) gate each slot — inactive slots contribute zero value via `effective_value = value * has_input`. This enables flexible transaction composition (e.g. 3-to-1 consolidation, 1-to-4 split) without requiring separate circuit variants.

## Frontend Application

The `app/` directory contains a Next.js 14 frontend with Solana wallet adapter integration (Phantom, Solflare, Backpack). Pages cover all protocol operations: deposit, private transfer, withdrawal, stealth addresses, cross-chain bridge, and compliance (selective disclosure + wealth proofs). The SDK hook (`useHolanc`) provides a typed interface for proof generation and transaction submission.
