## Holanc EVM Contracts

This package contains the Solidity implementation of the Holanc protocol:

- `HolancVerifier.sol` — Groth16 verifier on BN254 precompiles
- `HolancNullifier.sol` — bitmap nullifier registry with epoch tracking
- `HolancPool.sol` — ERC-20 privacy pool with incremental SHA-256 Merkle tree
- `HolancBridge.sol` — cross-chain root sync and commitment locks
- `HolancCompliance.sol` — oracle disclosures and wealth-proof attestations

## Commands

### Build

```sh
forge build
```

### Test

```sh
forge test
```

### Format

```sh
forge fmt
```

## Deployment

The deployment script is `script/DeployHolanc.s.sol:DeployHolanc`.

Required environment variables:

```sh
export PRIVATE_KEY=0x...
export TOKEN_ADDRESS=0x...
```

Optional environment variables:

```sh
export FEE_COLLECTOR=0x...
export LZ_ENDPOINT=0x...
export LOCAL_CHAIN_ID=1
export LOCAL_APP_ID=1
export EPOCH_DURATION_BLOCKS=7200
export PROOF_EXPIRY_SECONDS=86400
export COMPLIANCE_MODE=1
```

`COMPLIANCE_MODE` values:

- `0` = `Permissionless`
- `1` = `OptionalDisclosure`
- `2` = `MandatoryDisclosure`

Run the deployment:

```sh
forge script script/DeployHolanc.s.sol:DeployHolanc \
	--rpc-url "$ETH_RPC_URL" \
	--broadcast
```

The script prints the deployed addresses in `.env`-friendly form:

```sh
HOLANC_VERIFIER_ADDRESS=0x...
HOLANC_NULLIFIER_ADDRESS=0x...
HOLANC_POOL_ADDRESS=0x...
HOLANC_BRIDGE_ADDRESS=0x...
HOLANC_COMPLIANCE_ADDRESS=0x...
```

## Post-deploy

After deployment you still need to:

1. initialize verification keys in `HolancVerifier`
2. set trusted LayerZero peers on `HolancBridge`
3. register compliance oracles if compliance mode requires them
