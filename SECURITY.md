# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability in Holanc, please report it responsibly:

1. **Do not** open a public issue.
2. Email **security@soulresearch.dev** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)
3. You will receive an acknowledgment within 48 hours.
4. We will coordinate a fix and disclosure timeline with you.

## Scope

The following components are in scope:

- **Solana programs** (`programs/`) — logic bugs, access control bypasses, arithmetic overflows
- **Circom circuits** (`circuits/`) — constraint soundness, under-constrained signals, malleability
- **Cryptographic primitives** (`crates/holanc-primitives/`) — hash collisions, nullifier uniqueness
- **Note encryption** (`crates/holanc-note/`) — key leakage, ciphertext malleability
- **TypeScript SDK** (`sdk/typescript/`) — proof generation correctness, key management

## Out of Scope

- Frontend UI issues that don't affect security
- Denial-of-service against the public RPC
- Issues in third-party dependencies (report to the upstream project)

## Security Considerations

### Trusted Setup

Groth16 requires a per-circuit trusted setup ceremony. The Powers of Tau phase uses community contributions. Circuit-specific phase 2 should use multi-party computation before production deployment.

### Nullifier Soundness

Double-spend prevention relies on the nullifier registry's bitmap. The on-chain program enforces uniqueness checks within each page. Cross-chain nullifier isolation uses V2 domain-separated nullifiers with `(chain_id, app_id)` binding.

### Viewing Key Disclosure

The compliance layer's viewing key disclosure is strictly opt-in. Encrypted viewing keys use ChaCha20-Poly1305. Oracle permissions are granular and revocable.
