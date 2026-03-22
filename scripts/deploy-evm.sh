#!/usr/bin/env bash
# deploy-evm.sh — Deploy the Holanc EVM contracts via Foundry
#
# Usage:
#   export ETH_RPC_URL=https://...
#   export PRIVATE_KEY=0x...
#   export TOKEN_ADDRESS=0x...
#   ./scripts/deploy-evm.sh [--broadcast] [--verify]
#
# Without --broadcast the script runs a dry-run simulation.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVM_DIR="$ROOT_DIR/contracts/evm"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $*"; }
err() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ---------- Validate required env ----------
[[ -z "${ETH_RPC_URL:-}" ]]      && err "ETH_RPC_URL is not set"
[[ -z "${PRIVATE_KEY:-}" ]]       && err "PRIVATE_KEY is not set"
[[ -z "${TOKEN_ADDRESS:-}" ]]     && err "TOKEN_ADDRESS is not set"

command -v forge >/dev/null 2>&1 || err "forge not found — install Foundry: https://getfoundry.sh"

# ---------- Parse flags ----------
BROADCAST=""
VERIFY=""
for arg in "$@"; do
  case "$arg" in
    --broadcast) BROADCAST="--broadcast" ;;
    --verify)    VERIFY="--verify" ;;
    *)           err "Unknown flag: $arg" ;;
  esac
done

# ---------- Build ----------
log "Building EVM contracts..."
cd "$EVM_DIR"
forge build

# ---------- Deploy ----------
if [[ -n "$BROADCAST" ]]; then
  log "Broadcasting deployment transactions to $ETH_RPC_URL ..."
else
  log "Running dry-run simulation (pass --broadcast to deploy for real)..."
fi

forge script script/DeployHolanc.s.sol:DeployHolanc \
  --rpc-url "$ETH_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  $BROADCAST \
  $VERIFY \
  -vvv

log "Done."
