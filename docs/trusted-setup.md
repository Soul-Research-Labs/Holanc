# Trusted Setup Ceremony Guide

This document describes the multi-party computation (MPC) ceremony required to
produce production Groth16 proving keys for the Holanc privacy protocol. A
trusted setup is necessary because Groth16 proofs rely on a structured reference
string (SRS) that contains "toxic waste" — if any single party retains it, they
can forge proofs. An MPC ceremony ensures security as long as **at least one
participant destroys their secret contribution**.

## Overview

The ceremony has two phases:

| Phase                          | Scope                                | Shared across circuits? |
| ------------------------------ | ------------------------------------ | ----------------------- |
| **Phase 1 — Powers of Tau**    | Generates universal SRS parameters   | Yes                     |
| **Phase 2 — Circuit-specific** | Specialises the SRS for each circuit | No (one per circuit)    |

Holanc has **11 circuits** (see `circuits/` directory). Phase 1 is performed
once; Phase 2 must be repeated per circuit.

## Prerequisites

```bash
# snarkjs (v0.7+)
npm install -g snarkjs

# circom (v2.1+) — only needed to recompile circuits
# https://docs.circom.io/getting-started/installation/
```

## Phase 1 — Powers of Tau

The development setup (see `scripts/setup-circuits.sh`) downloads a
pre-computed Hermez Phase 1 file. For production you should either:

1. **Use a well-known community ceremony** (recommended):

   - [Ethereum KZG Ceremony](https://ceremony.ethereum.org/) outputs
   - [Hermez Phase 1](https://blog.hermez.io/hermez-cryptographic-setup/) files
   - Iden3/SnarkJS Perpetual Powers of Tau

2. **Run your own Phase 1** (max control, more effort):

```bash
# Start a new ceremony (2^16 constraints supports all Holanc circuits)
snarkjs powersoftau new bn128 16 pot16_0000.ptau -v

# Each participant contributes in sequence
snarkjs powersoftau contribute pot16_0000.ptau pot16_0001.ptau \
  --name="Participant 1" -v
snarkjs powersoftau contribute pot16_0001.ptau pot16_0002.ptau \
  --name="Participant 2" -v
# ... repeat for all participants ...

# Apply a random beacon (e.g. Bitcoin block hash at a future height)
BEACON="0000000000000000000af023a..."
snarkjs powersoftau beacon pot16_NNNN.ptau pot16_beacon.ptau \
  "$BEACON" 10 -v

# Prepare for Phase 2
snarkjs powersoftau prepare phase2 pot16_beacon.ptau pot16_final.ptau -v

# Verify the entire Phase 1 chain
snarkjs powersoftau verify pot16_final.ptau
```

### Phase 1 Security Considerations

- Use ≥ 5 independent contributors on different hardware/OS.
- Each contributor should generate entropy from hardware RNG (`/dev/urandom`).
- The random beacon should be a value not known at ceremony start
  (e.g. a future Ethereum block hash, Bitcoin block hash, or drand beacon).
- Publish the transcript so anyone can verify the chain.

## Phase 2 — Circuit-Specific Setup

Phase 2 must be performed **once per circuit**. The circuits are:

```
deposit, transfer, withdraw, transfer_v2, withdraw_v2,
stealth_transfer, stealth_transfer_v2, wealth_proof,
transfer_4x4, withdraw_4x4, withdraw_v2_4x4
```

### Compile Circuits

```bash
# Compile all circuits (generates .r1cs and .wasm artifacts)
./scripts/setup-circuits.sh
# OR compile individually:
circom circuits/transfer/transfer.circom --r1cs --wasm --sym \
  -l circuits/node_modules -o circuits/build/transfer
```

### Phase 2 Ceremony Per Circuit

```bash
CIRCUIT="transfer"  # repeat for each circuit
BUILD="circuits/build/$CIRCUIT"
PTAU="circuits/ptau/pot16_final.ptau"

# 1. Initial zkey from Phase 1 output + circuit R1CS
snarkjs groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$PTAU" \
  "$BUILD/${CIRCUIT}_0000.zkey"

# 2. Each participant contributes
snarkjs zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" \
  "$BUILD/${CIRCUIT}_0001.zkey" \
  --name="Participant 1" -v

snarkjs zkey contribute "$BUILD/${CIRCUIT}_0001.zkey" \
  "$BUILD/${CIRCUIT}_0002.zkey" \
  --name="Participant 2" -v

# ... repeat for all participants ...

# 3. Apply random beacon
snarkjs zkey beacon "$BUILD/${CIRCUIT}_NNNN.zkey" \
  "$BUILD/${CIRCUIT}_final.zkey" \
  "$BEACON" 10 -v

# 4. Export verification key
snarkjs zkey export verificationkey \
  "$BUILD/${CIRCUIT}_final.zkey" \
  "$BUILD/${CIRCUIT}_vkey.json"

# 5. Verify the final zkey against the PTAU and R1CS
snarkjs zkey verify "$BUILD/${CIRCUIT}.r1cs" "$PTAU" \
  "$BUILD/${CIRCUIT}_final.zkey"
```

### Phase 2 Automation Script

For convenience, a wrapper script can orchestrate all 11 circuits:

```bash
#!/usr/bin/env bash
set -euo pipefail

CIRCUITS=(deposit transfer withdraw transfer_v2 withdraw_v2 \
  stealth_transfer stealth_transfer_v2 wealth_proof \
  transfer_4x4 withdraw_4x4 withdraw_v2_4x4)

for c in "${CIRCUITS[@]}"; do
  echo "=== Phase 2 for $c ==="
  snarkjs groth16 setup "circuits/build/$c/${c}.r1cs" \
    circuits/ptau/pot16_final.ptau "circuits/build/$c/${c}_0000.zkey"

  # Add contributions here (interactive or batched)
  snarkjs zkey contribute "circuits/build/$c/${c}_0000.zkey" \
    "circuits/build/$c/${c}_final.zkey" \
    --name="Production contribution" -v \
    -e="$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')"

  snarkjs zkey export verificationkey \
    "circuits/build/$c/${c}_final.zkey" \
    "circuits/build/$c/${c}_vkey.json"

  snarkjs zkey verify "circuits/build/$c/${c}.r1cs" \
    circuits/ptau/pot16_final.ptau "circuits/build/$c/${c}_final.zkey"
done
```

## Verification

Anyone can verify the ceremony artifacts without participating:

```bash
# Verify Phase 1
snarkjs powersoftau verify circuits/ptau/pot16_final.ptau

# Verify each circuit's Phase 2
snarkjs zkey verify circuits/build/transfer/transfer.r1cs \
  circuits/ptau/pot16_final.ptau \
  circuits/build/transfer/transfer_final.zkey
```

Verification checks:

- Each contribution is correctly chained (no tampering).
- The random beacon was correctly applied.
- The final zkey is consistent with the R1CS constraints.

## Deploying Ceremony Outputs

After the ceremony, the following artifacts go into production:

| Artifact       | Location                | Used by                    |
| -------------- | ----------------------- | -------------------------- |
| `*_final.zkey` | Client-side prover      | `holanc-prover` crate, SDK |
| `*_vkey.json`  | On-chain verifier       | `holanc-verifier` program  |
| `*.wasm`       | Client-side witness gen | `holanc-prover` crate, SDK |

The verification keys must be embedded in or loaded by the on-chain verifier
program. The `.zkey` files are distributed to client provers (CLI, SDK, frontend).

### On-Chain Verifier Update

When new ceremony keys are produced, update the verification key constants in
`programs/holanc-verifier/src/lib.rs`:

```rust
// Replace with values from the new *_vkey.json
pub const TRANSFER_VK_ALPHA: [u8; 64] = [...];
pub const TRANSFER_VK_BETA: [u8; 128] = [...];
pub const TRANSFER_VK_GAMMA: [u8; 64] = [...];
pub const TRANSFER_VK_DELTA: [u8; 64] = [...];
pub const TRANSFER_VK_IC: [[u8; 64]; N] = [...];
```

## Coordinator Checklist

- [ ] Recruit ≥ 5 independent participants (different orgs, jurisdictions)
- [ ] Distribute Phase 1 PTAU file to all participants
- [ ] Collect and chain Phase 1 contributions
- [ ] Apply Phase 1 random beacon and prepare Phase 2
- [ ] For each of the 11 circuits, run Phase 2 ceremony
- [ ] Apply Phase 2 random beacon per circuit
- [ ] Run `snarkjs zkey verify` on all final keys
- [ ] Publish transcript (hashes of each contribution)
- [ ] Distribute `*_final.zkey` and `*_vkey.json` to deployment pipeline
- [ ] Update on-chain verifier constants with new verification keys
- [ ] Destroy local copies of intermediate contribution files

## Ceremony Transcript Format

Publish a JSON transcript for each circuit:

```json
{
  "circuit": "transfer",
  "phase1_ptau": "powersOfTau28_bnbn128_final_16.ptau",
  "phase1_ptau_hash": "sha256:...",
  "contributions": [
    {
      "index": 1,
      "name": "Participant 1",
      "hash": "sha256:...",
      "timestamp": "2025-01-15T10:00:00Z"
    }
  ],
  "beacon": {
    "value": "0000000000000000...",
    "source": "Bitcoin block #876543",
    "iterations": 10
  },
  "final_zkey_hash": "sha256:...",
  "verification_key_hash": "sha256:..."
}
```

## Development vs Production

| Aspect                | Development (`setup-circuits.sh`) | Production (this guide)   |
| --------------------- | --------------------------------- | ------------------------- |
| Phase 1               | Pre-computed Hermez download      | MPC or community ceremony |
| Phase 2 contributions | 1 (dev random)                    | ≥ 5 independent           |
| Random beacon         | None                              | Required                  |
| Transcript            | Not published                     | Publicly verified         |
| Trust assumption      | Fully trusted dev                 | 1-of-N honest participant |
