<p align="center">
  <strong>Holanc</strong><br>
  Cross-chain ZK privacy protocol for Solana and SVM-compatible blockchains
</p>

<p align="center">
  <a href="LICENSE-MIT"><img src="https://img.shields.io/badge/license-MIT%2FApache--2.0-blue" alt="License"></a>
  <a href="https://github.com/Soul-Research-Labs/Holanc"><img src="https://img.shields.io/badge/solana-mainnet--beta-blueviolet" alt="Solana"></a>
  <a href="SECURITY.md"><img src="https://img.shields.io/badge/security-policy-green" alt="Security"></a>
</p>

---

## Overview

Holanc is a **shielded pool protocol** that enables private deposits, transfers, and withdrawals on Solana using **Groth16 zero-knowledge proofs** over the BN254 curve. Notes are committed into an on-chain Merkle tree; spending requires proving knowledge of a valid note without revealing which one, while nullifiers prevent double-spending.

**Key capabilities:**

- **Unlinkable transactions** — ZK proofs break the on-chain link between deposits, transfers, and withdrawals
- **~200k CU on-chain verification** — Native Solana `alt_bn128` syscalls (add, mul, pairing)
- **Cross-chain nullifiers** — Domain-separated nullifiers with epoch sync for Solana + Eclipse + Sonic
- **Stealth addresses** — Ephemeral key exchange for one-time receive addresses
- **Compliance layer** — Optional oracle-based viewing key disclosure + ZK wealth attestations
- **Variable I/O** — 2-in/2-out and 4-in/4-out circuit variants for flexible transaction sizes

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Client (TypeScript / Rust)                 │
│  wallet · note management · proof generation · stealth addr │
└────────────┬────────────────────┬───────────────────────────┘
             │                    │
   ┌─────────▼──────┐   ┌───────▼────────┐   ┌──────────────┐
   │  holanc-pool   │   │ holanc-verifier│   │holanc-bridge │
   │ (deposit /     │   │ (Groth16 proof │   │ (Wormhole    │
   │  transfer /    │◄──│  verification  │   │  cross-chain │
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

## Project Layout

```
programs/                  Solana / Anchor on-chain programs
  holanc-pool/               Privacy pool (deposit, transfer, withdraw)
  holanc-verifier/           Groth16 proof verification (alt_bn128)
  holanc-nullifier/          Nullifier registry + epoch management
  holanc-bridge/             Wormhole cross-chain epoch sync
  holanc-compliance/         Optional compliance hooks + wealth proofs

crates/                    Off-chain Rust libraries
  holanc-primitives/         Poseidon hash, commitments, nullifiers
  holanc-note/               Note model, keys, encryption
  holanc-tree/               Incremental Poseidon Merkle tree (depth 20)
  holanc-prover/             Circuit input generation + snarkjs bridge
  holanc-client/             Wallet, coin selection, persistence
  holanc-cli/                Interactive REPL

circuits/                  Circom 2.2 ZK circuits
  deposit/                   Commitment preimage proof
  transfer/                  2-in-2-out private transfer
  withdraw/                  Withdrawal with public exit_value
  transfer_v2/               Domain-separated nullifiers
  withdraw_v2/               Domain-separated withdrawal
  stealth_transfer/          Stealth address transfer
  wealth_proof/              ZK balance threshold (up to 8 notes)
  transfer_4x4/              4-in-4-out variable I/O transfer
  withdraw_4x4/              4-in-4-out variable I/O withdrawal
  lib/                       Shared templates (Poseidon, Merkle, etc.)

sdk/typescript/            TypeScript SDK (@holanc/sdk)
app/                       Next.js 14 frontend
relayer/                   Privacy-preserving transaction relay
indexer/                   On-chain event indexer (SQLite + replication)
deploy/                    Docker Compose + Dockerfiles
scripts/                   Dev setup + circuit compilation scripts
docs/                      Protocol documentation
tests/                     Integration, circuit, and E2E tests
```

## Prerequisites

| Tool        | Version | Purpose                      |
|-------------|---------|------------------------------|
| Rust        | ≥ 1.75  | Workspace crates + programs  |
| Solana CLI  | ≥ 2.1   | Validator, deploy, keypairs  |
| Anchor      | ≥ 0.32  | Program build & test         |
| Node.js     | ≥ 18    | SDK, relayer, indexer, app   |
| Circom      | ≥ 2.2   | Circuit compilation          |
| snarkjs     | ≥ 0.7   | Proving key gen & proving    |

## Quick Start

```bash
# One-command setup (installs deps, compiles circuits, builds everything)
chmod +x scripts/dev-setup.sh && ./scripts/dev-setup.sh

# — or step by step —

# 1. Build Rust workspace (crates + programs)
cargo build

# 2. Run Rust unit tests (60+ tests across 6 crates)
cargo test

# 3. Build Anchor programs
anchor build

# 4. Compile circuits + trusted setup (Powers of Tau + phase 2)
./scripts/setup-circuits.sh

# 5. Run Anchor integration tests (starts local validator)
anchor test

# 6. Run TypeScript SDK tests
cd sdk/typescript && npm test

# 7. Launch interactive CLI
cargo run --bin holanc-cli
```

## Cryptographic Primitives

| Component             | Construction                                             |
|-----------------------|----------------------------------------------------------|
| Hash function         | Poseidon (BN254, width=3, rate=2, circomlib-compatible)  |
| Note commitment       | `Poseidon(owner, value, asset_id, blinding)`             |
| Nullifier (V1)        | `Poseidon(spending_key, commitment)`                     |
| Nullifier (V2)        | `Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))` |
| Merkle tree           | Incremental Poseidon tree (depth 20) + on-chain SHA-256  |
| Proving system        | Groth16 on BN254                                         |
| On-chain verification | Solana `alt_bn128` syscalls (add, mul, pairing)          |
| Note encryption       | ECDH (BabyJubJub) + HKDF-SHA256 + AES-256-GCM           |
| Key derivation        | BIP-39 mnemonic → spending key → viewing key (Poseidon)  |
| Stealth addresses     | Ephemeral key exchange → Poseidon-derived one-time owner |

## Circuit Reference

| Circuit            | Inputs | Outputs | Key Constraints |
|--------------------|--------|---------|-----------------|
| `deposit`          | 0      | 1       | Commitment preimage validity |
| `transfer`         | 2      | 2       | Merkle inclusion, nullifiers, value conservation: `Σ(in) = Σ(out) + fee` |
| `withdraw`         | 2      | 2       | Same as transfer + public `exit_value`: `Σ(in) = Σ(out) + exit + fee` |
| `transfer_v2`      | 2      | 2       | Domain-separated nullifiers for cross-chain |
| `withdraw_v2`      | 2      | 2       | V2 nullifiers + public exit |
| `stealth_transfer` | 2      | 2       | Ephemeral key derivation + transfer constraints |
| `wealth_proof`     | 0–8    | 0       | Balance threshold: `Σ(owned values) ≥ threshold` |
| `transfer_4x4`     | 0–4    | 0–4     | Boolean selectors, variable I/O, cross-asset consistency |
| `withdraw_4x4`     | 0–4    | 0–4     | Variable I/O + public exit |

## Services

### Relayer

Privacy-preserving transaction relay with k-anonymity batching and jitter scheduling:

```bash
cd relayer && npm install && npm start   # default: port 3001
```

### Indexer

On-chain event scanner with SQLite persistence and optional WAL-mode replication:

```bash
cd indexer && npm install && npm start   # default: port 3002
```

### Frontend

Next.js 14 application with Solana wallet adapter — Dashboard, Deposit, Transfer, Withdraw, Stealth Addresses, Bridge, Compliance:

```bash
cd app && npm install && npm run dev     # default: port 3000
```

### Docker (full stack)

```bash
cd deploy && docker compose up
```

Starts: `solana-test-validator` → `relayer` (3001) → `indexer` (3002) → `app` (3000).

## Testing

| Runner            | Command                         | Scope                                                  |
|-------------------|----------------------------------|--------------------------------------------------------|
| Cargo             | `cargo test`                    | Primitives, note, tree, client, prover, CLI            |
| Anchor (ts-mocha) | `anchor test`                   | On-chain programs, CPI flows, full deposit→transfer→withdraw |
| Jest (SDK)        | `cd sdk/typescript && npm test` | Poseidon, encryption, wallet, stealth, RPC failover    |
| Jest (Relayer)    | `cd relayer && npm test`        | Batcher retry, fees, jitter, rate limiting             |
| Jest (Indexer)    | `cd indexer && npm test`        | Store operations, replication, WAL mode                |
| Next.js           | `cd app && npm run build`       | Type-check + build all 7 pages                         |

## Environment Variables

Copy [`.env.example`](.env.example) and customize:

```bash
cp .env.example .env
```

Key variables: `SOLANA_RPC_URL`, `POOL_PROGRAM_ID`, `VERIFIER_PROGRAM_ID`, `NULLIFIER_PROGRAM_ID`, `BRIDGE_PROGRAM_ID`, `RELAYER_PORT`, `INDEXER_PORT`, `NEXT_PUBLIC_RPC_URL`. See `.env.example` for defaults.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System overview and component design |
| [Protocol](docs/protocol.md) | Cryptographic specification |
| [Circuit Constraints](docs/circuit-constraints.md) | Formal constraint analysis |
| [Cross-chain Privacy](docs/cross-chain-privacy.md) | Domain-separated nullifiers and epoch sync |
| [Stealth Addresses](docs/stealth-addresses.md) | One-time address protocol |
| [Threat Model](docs/threat-model.md) | Trust assumptions and adversary models |
| [Trusted Setup](docs/trusted-setup.md) | MPC ceremony guide for production keys |
| [API Reference](docs/api-reference.md) | SDK, programs, and relayer API |
| [Getting Started](docs/getting-started.md) | Setup and development guide |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting. Please report issues to **security@soulresearch.dev** — do not open public issues for security bugs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, code style, and PR guidelines.

## License

Dual-licensed under [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE).
