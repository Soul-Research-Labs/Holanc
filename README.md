# Holanc

**Cross-chain ZK privacy protocol for Solana and SVM-compatible blockchains.**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Client (TypeScript/Rust)                   │
│  wallet • note management • proof generation • stealth addr │
└────────────┬────────────────────┬───────────────────────────┘
             │                    │
   ┌─────────▼──────┐   ┌───────▼────────┐   ┌──────────────┐
   │  holanc-pool   │   │ holanc-verifier│   │holanc-bridge │
   │ (deposit/      │   │ (Groth16 proof │   │ (Wormhole    │
   │  transfer/     │◄──│  verification  │   │  cross-chain │
   │  withdraw)     │   │  via alt_bn128)│   │  epoch sync) │
   └────────┬───────┘   └────────────────┘   └──────────────┘
            │
   ┌────────▼───────────┐   ┌────────────────────┐
   │ holanc-nullifier   │   │ holanc-compliance  │
   │ (double-spend      │   │ (optional oracle   │
   │  prevention +      │   │  disclosure +      │
   │  epoch sync +      │   │  ZK wealth proofs) │
   │  V2 domain sep.)   │   │                    │
   └────────────────────┘   └────────────────────┘
```

### Key Properties

- **Privacy**: Deposits, transfers, and withdrawals are unlinkable via ZK proofs
- **Groth16 on BN254**: Native Solana `alt_bn128` syscalls for on-chain verification (~200k CU)
- **Cross-chain ready**: Epoch-based nullifier sync designed for Solana + Eclipse + Sonic
- **Stealth addresses**: Unlinkable one-time receive addresses via ephemeral key exchange
- **Compliance layer**: Optional oracle-based viewing key disclosure + ZK wealth attestations
- **Circom circuits**: Composable with the broader circomlib ecosystem

## Project Structure

```
├── programs/                  # Solana/Anchor programs
│   ├── holanc-pool/           # Privacy pool (deposit/transfer/withdraw)
│   ├── holanc-verifier/       # Groth16 proof verification
│   ├── holanc-nullifier/      # Nullifier registry + epochs
│   ├── holanc-bridge/         # Wormhole cross-chain epoch sync
│   └── holanc-compliance/     # Optional compliance hooks + wealth proofs
├── crates/                    # Off-chain Rust libraries
│   ├── holanc-primitives/     # Poseidon hash, commitments, nullifiers
│   ├── holanc-note/           # Note model, keys, encryption
│   ├── holanc-tree/           # Incremental Poseidon Merkle tree
│   ├── holanc-prover/         # Circuit input generation
│   ├── holanc-client/         # Wallet, coin selection
│   └── holanc-cli/            # Interactive REPL
├── circuits/                  # Circom ZK circuits
│   ├── deposit/               # Deposit commitment proof
│   ├── transfer/              # 2-in-2-out private transfer
│   ├── withdraw/              # Withdrawal proof
│   ├── transfer_v2/           # Transfer with domain-separated nullifiers
│   ├── withdraw_v2/           # Withdraw with domain-separated nullifiers
│   ├── stealth_transfer/      # Stealth address private transfer
│   ├── wealth_proof/          # ZK balance threshold proof
│   ├── transfer_4x4/         # Variable I/O transfer (4-in, 4-out)
│   ├── withdraw_4x4/         # Variable I/O withdraw (4-in, 4-out)
│   └── lib/                   # Shared templates (Poseidon, Merkle, etc.)
├── sdk/typescript/            # TypeScript SDK (@holanc/sdk)
├── app/                       # Next.js frontend (wallet, deposit, transfer, withdraw, stealth, bridge, compliance)
├── relayer/                   # Privacy-preserving transaction relay service
├── indexer/                   # On-chain event indexer
├── deploy/                    # Docker Compose + Dockerfiles
├── scripts/                   # Setup and build scripts
├── docs/                      # Protocol documentation
└── tests/                     # Integration + circuit + e2e tests
```

## Prerequisites

- **Rust** ≥ 1.75 (with `cargo`)
- **Solana CLI** ≥ 2.1
- **Anchor** ≥ 0.32
- **Node.js** ≥ 18 (with `npm`/`yarn`)
- **Circom** ≥ 2.2
- **snarkjs** ≥ 0.7

## Quick Start

```bash
# Install dependencies and build everything
chmod +x scripts/dev-setup.sh
./scripts/dev-setup.sh

# Or step by step:

# 1. Build Rust workspace
cargo build

# 2. Run tests (60 unit tests across 6 crates)
cargo test

# 3. Build Anchor programs
anchor build

# 4. Compile circuits + generate proving keys
./scripts/setup-circuits.sh

# 5. Start local validator and run integration tests
anchor test

# 6. Run TypeScript SDK tests
cd sdk/typescript && npm test

# 7. Interactive CLI
cargo run --bin holanc-cli
```

## Cryptographic Primitives

| Component             | Implementation                                           |
| --------------------- | -------------------------------------------------------- |
| Hash function         | Poseidon (BN254, width=3, rate=2, circomlib-compatible)  |
| Note commitment       | `Poseidon(owner, value, asset_id, blinding)`             |
| Nullifier (V1)        | `Poseidon(spending_key, commitment)`                     |
| Nullifier (V2)        | `Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))` |
| Merkle tree           | Incremental Poseidon tree (depth 20) + on-chain SHA-256  |
| Proving system        | Groth16 on BN254                                         |
| On-chain verification | Solana `alt_bn128` syscalls (add, mul, pairing)          |
| Note encryption       | ChaCha20-Poly1305 with HKDF-SHA256 key derivation        |
| Key derivation        | BIP-39 mnemonic → spending key → viewing key (Poseidon)  |
| Stealth addresses     | Ephemeral key exchange → Poseidon-derived one-time owner |

## Circuits

### Transfer (2-in, 2-out)

Proves knowledge of input notes in the Merkle tree, derives nullifiers, creates output commitments, and enforces value conservation: `Σ(inputs) = Σ(outputs) + fee`.

### Withdraw

Extends the transfer circuit with a public `exit_value` for on-chain token release: `Σ(inputs) = Σ(outputs) + exit_value + fee`.

### Deposit

Proves knowledge of commitment preimage to prevent invalid deposits.

### Transfer V2 / Withdraw V2

Same as base circuits with domain-separated nullifiers: `nullifier = Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))`. Prevents cross-chain double-spend.

### Stealth Transfer

Extends the transfer circuit with ephemeral key derivation constraints. Proves that `stealth_owner = Poseidon(recipient_spending_pubkey, Poseidon(ephemeral_key, recipient_spending_pubkey))`.

### Wealth Proof

Proves total balance across up to 8 shielded notes exceeds a public threshold, without revealing the exact balance. Uses per-note Merkle inclusion, ownership verification, and 64-bit range checks.

### Transfer 4×4 / Withdraw 4×4 (Variable I/O)

Generalized circuits supporting up to 4 inputs and 4 outputs with boolean selectors (`has_input[i]`, `has_output[j]`). Inactive slots are zeroed out via `effective_value = value * has_input`. Asset ID consistency enforced across active inputs. Withdraw variant adds a public `exit_value`.

## Frontend App

A Next.js 14 application in `app/` with Solana wallet adapter integration.

```bash
# Start the frontend
cd app
npm install
npm run dev
```

## Testing

| Runner            | Command                         | Scope                                                                              |
| ----------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Cargo (Rust)      | `cargo test`                    | 60 unit/integration tests across primitives, note, tree, client, prover            |
| ts-mocha (Anchor) | `anchor test`                   | Smoke tests, pool/verifier/nullifier/bridge/compliance instructions, full E2E flow |
| Jest (SDK)        | `cd sdk/typescript && npm test` | Poseidon, stealth addresses, wallet, encryption                                    |
| Next.js build     | `cd app && npm run build`       | Type-checks and builds all 7 pages                                                 |

## Docker

```bash
cd deploy
docker compose up
```

Starts a full local stack: `solana-test-validator` → `relayer` (port 3001) → `indexer` → `app` (port 3000).

## Documentation

See [docs/](docs/) for detailed protocol documentation:

- [Architecture](docs/architecture.md) — System overview and component design
- [Protocol](docs/protocol.md) — Cryptographic specification
- [Circuit Constraints](docs/circuit-constraints.md) — Formal constraint analysis
- [Cross-chain Privacy](docs/cross-chain-privacy.md) — Domain-separated nullifiers and epoch sync
- [Stealth Addresses](docs/stealth-addresses.md) — One-time address protocol
- [Threat Model](docs/threat-model.md) — Trust assumptions and adversary models
- [API Reference](docs/api-reference.md) — Full API docs for programs, SDK, and relayer
- [Getting Started](docs/getting-started.md) — Setup guide

```

Pages: Dashboard, Deposit, Transfer, Withdraw, Stealth Addresses, Cross-Chain Bridge, Compliance.

## License

MIT OR Apache-2.0
```
