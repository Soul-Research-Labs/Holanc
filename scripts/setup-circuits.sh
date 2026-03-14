#!/usr/bin/env bash
# setup-circuits.sh — Compile Circom circuits + generate Groth16 keys
#
# Prerequisites:
#   - circom 2.x  (https://docs.circom.io/getting-started/installation/)
#   - snarkjs     (npm install -g snarkjs)
#   - wget / curl
#
# Usage:
#   chmod +x scripts/setup-circuits.sh
#   ./scripts/setup-circuits.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CIRCUITS_DIR="$ROOT_DIR/circuits"
BUILD_DIR="$CIRCUITS_DIR/build"
PTAU_DIR="$CIRCUITS_DIR/ptau"

# Powers-of-Tau ceremony file (2^16 constraints is enough for our circuits)
PTAU_SIZE=16
PTAU_FILE="$PTAU_DIR/powersOfTau28_bnbn128_${PTAU_SIZE}.ptau"
PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_bnbn128_final_${PTAU_SIZE}.ptau"

CIRCUITS=("deposit" "transfer" "withdraw" "transfer_v2" "withdraw_v2" "stealth_transfer" "stealth_transfer_v2" "wealth_proof" "transfer_4x4" "withdraw_4x4" "withdraw_v2_4x4")

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; }

# ---------- Check prerequisites ----------
command -v circom >/dev/null 2>&1 || { err "circom not found. Install: https://docs.circom.io/getting-started/installation/"; exit 1; }
command -v snarkjs >/dev/null 2>&1 || { err "snarkjs not found. Install: npm install -g snarkjs"; exit 1; }

# ---------- Download Powers of Tau ----------
mkdir -p "$PTAU_DIR"
if [[ ! -f "$PTAU_FILE" ]]; then
  log "Downloading Powers of Tau (2^${PTAU_SIZE})..."
  if command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$PTAU_FILE" "$PTAU_URL"
  else
    curl -L --progress-bar -o "$PTAU_FILE" "$PTAU_URL"
  fi
else
  log "Powers of Tau file already exists, skipping download."
fi

# ---------- Install circomlib as npm dep ----------
if [[ ! -d "$CIRCUITS_DIR/node_modules/circomlib" ]]; then
  log "Installing circomlib..."
  (cd "$CIRCUITS_DIR" && npm init -y --silent 2>/dev/null && npm install --save circomlib 2>/dev/null)
fi

# ---------- Compile & generate keys for each circuit ----------
for circuit in "${CIRCUITS[@]}"; do
  CIRCUIT_FILE="$CIRCUITS_DIR/${circuit}/${circuit}.circom"
  CIRCUIT_BUILD="$BUILD_DIR/${circuit}"

  if [[ ! -f "$CIRCUIT_FILE" ]]; then
    warn "Circuit file not found: $CIRCUIT_FILE — skipping."
    continue
  fi

  log "=== Processing circuit: ${circuit} ==="
  mkdir -p "$CIRCUIT_BUILD"

  # 1. Compile
  log "  Compiling ${circuit}.circom..."
  circom "$CIRCUIT_FILE" \
    --r1cs \
    --wasm \
    --sym \
    -l "$CIRCUITS_DIR/node_modules" \
    -o "$CIRCUIT_BUILD"

  # 2. Circuit info
  log "  Circuit info:"
  snarkjs r1cs info "$CIRCUIT_BUILD/${circuit}.r1cs"

  # 3. Generate zkey (Groth16 setup)
  log "  Generating zkey (phase 2 setup)..."
  snarkjs groth16 setup \
    "$CIRCUIT_BUILD/${circuit}.r1cs" \
    "$PTAU_FILE" \
    "$CIRCUIT_BUILD/${circuit}_0000.zkey"

  # 4. Contribute to ceremony (non-interactive, random entropy)
  log "  Contributing to ceremony..."
  snarkjs zkey contribute \
    "$CIRCUIT_BUILD/${circuit}_0000.zkey" \
    "$CIRCUIT_BUILD/${circuit}_final.zkey" \
    --name="Holanc dev contribution" \
    -v -e="$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')"

  rm -f "$CIRCUIT_BUILD/${circuit}_0000.zkey"

  # 5. Export verification key
  log "  Exporting verification key..."
  snarkjs zkey export verificationkey \
    "$CIRCUIT_BUILD/${circuit}_final.zkey" \
    "$CIRCUIT_BUILD/${circuit}_vkey.json"

  # 6. Export Solidity verifier (optional, for reference)
  log "  Exporting Solidity verifier (reference)..."
  snarkjs zkey export solidityverifier \
    "$CIRCUIT_BUILD/${circuit}_final.zkey" \
    "$CIRCUIT_BUILD/${circuit}_verifier.sol" 2>/dev/null || true

  log "  ✓ ${circuit} complete."
  echo ""
done

log "All circuits compiled and keys generated in: $BUILD_DIR"
log ""
log "Artifacts per circuit:"
log "  ├── <circuit>.r1cs          — R1CS constraint system"
log "  ├── <circuit>.sym           — Symbol table"
log "  ├── <circuit>_js/           — WASM witness generator"
log "  ├── <circuit>_final.zkey    — Groth16 proving key"
log "  └── <circuit>_vkey.json     — Verification key"
