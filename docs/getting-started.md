# Getting Started

## Prerequisites

| Tool       | Version           | Purpose                                 |
| ---------- | ----------------- | --------------------------------------- |
| Rust       | 1.78+             | Solana programs + off-chain crates      |
| Solana CLI | 2.x / 3.x (Agave) | Cluster interaction, keypair management |
| Anchor CLI | 0.32.x            | Program build/deploy framework          |
| Node.js    | 22+               | SDK, relayer, indexer                   |
| Circom     | 2.2.x             | Circuit compilation                     |
| snarkjs    | 0.7.x             | Trusted setup + proof generation        |

## Quick Start

### 1. Clone and install dependencies

```bash
git clone <repo-url> holanc && cd holanc
make setup
```

`make setup` runs `scripts/dev-setup.sh`, which:

- Installs npm dependencies for the SDK, relayer, and indexer
- Compiles circuits and runs the Groth16 trusted setup (powers of tau + phase 2)
- Generates verification and proving keys under `circuits/build/`

### 2. Build everything

```bash
make build
```

This builds:

- Solana programs via `anchor build`
- Off-chain Rust crates via `cargo build`
- TypeScript SDK via `npm run build` in `sdk/typescript/`

### 3. Run tests

```bash
make test
```

Runs:

- `cargo test --workspace` — 43 unit tests across 6 Rust crates
- Anchor tests against a local validator (if running)

### 4. Start local development stack

```bash
# Option A: Docker (recommended)
make docker-up

# Option B: Manual
solana-test-validator &
cd relayer && npm run dev &
cd indexer && npm run dev &
```

The Docker stack launches:

- **solana-test-validator** on port 8899
- **Relayer** on port 3001
- **Indexer** polling the validator

### 5. Deploy programs to localnet

```bash
solana config set --url localhost
anchor deploy
```

Program IDs (from `Anchor.toml`):

- Pool: `6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT`
- Verifier: `GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi`
- Nullifier: `BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si`

## SDK Usage

### TypeScript

```typescript
import { HolancClient, HolancWallet, Prover } from "@holanc/sdk";
import { Connection, Keypair } from "@solana/web3.js";

const connection = new Connection("http://localhost:8899");
const payer = Keypair.generate();

// Initialize client
const client = new HolancClient(connection, payer, {
  poolProgramId: "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
  verifierProgramId: "GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi",
  nullifierProgramId: "BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si",
});

// Create a wallet from mnemonic
const wallet = HolancWallet.fromMnemonic(
  "your twelve word mnemonic phrase ...",
);

// Deposit 1 SOL
const depositTx = await client.deposit(wallet, 1_000_000_000);

// Check shielded balance
const balance = wallet.getBalance();

// Private transfer
const recipientPubkey = "...";
const transferTx = await client.transfer(wallet, recipientPubkey, 500_000_000);

// Withdraw 0.5 SOL
const withdrawTx = await client.withdraw(wallet, recipient, 500_000_000);
```

### Rust CLI

```bash
# Generate a new wallet
cargo run --bin holanc-cli -- wallet new

# Deposit
cargo run --bin holanc-cli -- deposit --amount 1.0

# Transfer
cargo run --bin holanc-cli -- transfer --to <pubkey> --amount 0.5

# Withdraw
cargo run --bin holanc-cli -- withdraw --to <address> --amount 0.5
```

## Relayer API

```bash
# Health check
curl http://localhost:3001/health

# Submit a transaction
curl -X POST http://localhost:3001/relay \
  -H 'Content-Type: application/json' \
  -d '{"transaction": "<base64-encoded-signed-tx>"}'

# Check relay status
curl http://localhost:3001/relay/<id>

# Get current fee estimate
curl http://localhost:3001/fee
```

## Project Structure

```
holanc/
├── programs/           # Solana/Anchor programs
│   ├── holanc-pool/    # Core privacy pool (deposit/transfer/withdraw)
│   ├── holanc-verifier/# Groth16 proof verification (alt_bn128)
│   └── holanc-nullifier/# Nullifier registry (bitmap + epochs)
├── crates/             # Off-chain Rust libraries
│   ├── holanc-primitives/ # Poseidon, commitments, nullifiers, envelopes
│   ├── holanc-note/    # Note encryption, keys, stealth addresses
│   ├── holanc-tree/    # Sparse Merkle tree
│   ├── holanc-prover/  # Proof generation helpers
│   ├── holanc-client/  # Wallet, coin selection, tx builder
│   └── holanc-cli/     # Interactive CLI (REPL)
├── circuits/           # Circom ZK circuits
│   ├── deposit.circom
│   ├── transfer.circom
│   ├── withdraw.circom
│   └── lib/common.circom
├── sdk/typescript/     # TypeScript SDK
├── relayer/            # Transaction relay service
├── indexer/            # Note indexer service
├── deploy/             # Docker Compose + Dockerfiles
├── scripts/            # Setup and build scripts
└── docs/               # Documentation
```
