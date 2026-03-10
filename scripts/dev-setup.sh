#!/usr/bin/env bash
# dev-setup.sh — Full development environment setup
#
# Usage:
#   chmod +x scripts/dev-setup.sh
#   ./scripts/dev-setup.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $*"; }
err() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ---------- Check toolchain ----------
log "Checking toolchain..."

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    log "  ✓ $1 found: $($1 --version 2>&1 | head -1)"
  else
    err "  ✗ $1 not found. $2"
    return 1
  fi
}

check_cmd "rustc"   "Install: https://rustup.rs"
check_cmd "cargo"   "Install: https://rustup.rs"
check_cmd "solana"  "Install: sh -c \"\$(curl -sSfL https://release.anza.xyz/stable/install)\""
check_cmd "anchor"  "Install: cargo install --git https://github.com/coral-xyz/anchor avm && avm install latest"
check_cmd "node"    "Install: https://nodejs.org"
check_cmd "circom"  "Install: https://docs.circom.io/getting-started/installation/"
check_cmd "snarkjs" "Install: npm install -g snarkjs"

# ---------- Install node dependencies ----------
log "Installing Node.js dependencies..."
cd "$ROOT_DIR"
if [[ -f "yarn.lock" ]]; then
  yarn install 2>/dev/null || npm install
else
  npm install
fi

# ---------- Install SDK deps ----------
if [[ -f "$ROOT_DIR/sdk/typescript/package.json" ]]; then
  log "Installing TypeScript SDK dependencies..."
  (cd "$ROOT_DIR/sdk/typescript" && npm install)
fi

# ---------- Install frontend deps ----------
if [[ -f "$ROOT_DIR/app/package.json" ]]; then
  log "Installing frontend app dependencies..."
  (cd "$ROOT_DIR/app" && npm install)
fi

# ---------- Build Rust workspace ----------
log "Building Rust workspace..."
cd "$ROOT_DIR"
cargo build 2>&1

# ---------- Build Anchor programs ----------
log "Building Anchor programs..."
anchor build 2>&1

# ---------- Compile circuits ----------
log "Setting up circuits..."
if [[ -x "$ROOT_DIR/scripts/setup-circuits.sh" ]]; then
  "$ROOT_DIR/scripts/setup-circuits.sh"
else
  chmod +x "$ROOT_DIR/scripts/setup-circuits.sh"
  "$ROOT_DIR/scripts/setup-circuits.sh"
fi

log ""
log "============================================"
log "  Development environment ready!"
log "============================================"
log ""
log "Next steps:"
log "  1. Start local validator:  solana-test-validator"
log "  2. Run Anchor tests:       anchor test"
log "  3. Run Rust tests:         cargo test"
log "  4. Start frontend dev:     make app-dev"
