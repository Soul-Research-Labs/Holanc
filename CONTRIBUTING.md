# Contributing to Holanc

Thank you for your interest in contributing to Holanc!

## Development Setup

```bash
# Clone and install
git clone https://github.com/Soul-Research-Labs/Holanc.git
cd Holanc
./scripts/dev-setup.sh
```

See [docs/getting-started.md](docs/getting-started.md) for detailed prerequisites.

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run tests:
   ```bash
   cargo test                          # Rust crates
   cargo clippy                        # Lint
   cargo fmt --check                   # Format check
   anchor build                        # Solana programs
   cd sdk/typescript && npm test       # SDK tests
   cd app && npm run build             # Frontend type-check
   ```
4. Open a pull request against `main`

## Code Style

- **Rust**: Follow `rustfmt` defaults. Run `cargo fmt` before committing.
- **TypeScript**: Follow Prettier defaults. Run `npm run lint:fix` from the root.
- **Circom**: Use consistent indentation and comment public signals.

## Project Areas

| Area | Path | Language |
|------|------|----------|
| On-chain programs | `programs/` | Rust (Anchor) |
| Off-chain libraries | `crates/` | Rust |
| ZK circuits | `circuits/` | Circom |
| TypeScript SDK | `sdk/typescript/` | TypeScript |
| Frontend | `app/` | TypeScript (Next.js) |
| Infrastructure | `relayer/`, `indexer/`, `deploy/` | TypeScript, Docker |
| Tests | `tests/` | TypeScript (Mocha) |

## Security

If you find a security vulnerability, please follow the [security policy](SECURITY.md) instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the project's dual MIT/Apache-2.0 license.
