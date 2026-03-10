# API Reference

## Solana Programs

### holanc-pool

**Program ID:** `6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT`

#### Instructions

##### `initialize`

Create a new privacy pool for a given token.

| Param      | Type     | Description                                |
| ---------- | -------- | ------------------------------------------ |
| `pool_id`  | `u64`    | Unique pool identifier                     |
| `asset_id` | `Pubkey` | SPL token mint (or system program for SOL) |

**Accounts:**

- `pool` (init, PDA: `["pool", pool_id]`)
- `vault` (init, token account)
- `authority` (signer, payer)
- `system_program`, `token_program`, `rent`

##### `deposit`

Deposit tokens into the shielded pool.

| Param        | Type       | Description                            |
| ------------ | ---------- | -------------------------------------- |
| `amount`     | `u64`      | Deposit amount in lamports/token units |
| `commitment` | `[u8; 32]` | Note commitment hash                   |
| `proof`      | `Vec<u8>`  | Groth16 proof (deposit circuit)        |

**Accounts:**

- `pool` (mut, PDA)
- `vault` (mut, token account)
- `depositor` (signer)
- `depositor_token_account` (mut)
- `verifier_program` (program)
- `token_program`

**Events:**

- `DepositEvent { pool_id, commitment, leaf_index, encrypted_note }`

##### `transfer`

Execute a private transfer between shielded notes.

| Param             | Type            | Description                                  |
| ----------------- | --------------- | -------------------------------------------- |
| `root`            | `[u8; 32]`      | Merkle root (must be in recent root history) |
| `nullifiers`      | `[[u8; 32]; 2]` | Input nullifiers                             |
| `out_commitments` | `[[u8; 32]; 2]` | Output commitments                           |
| `proof`           | `Vec<u8>`       | Groth16 proof (transfer circuit)             |
| `encrypted_notes` | `Vec<u8>`       | Encrypted output note data                   |

**Accounts:**

- `pool` (mut, PDA)
- `nullifier_registry` (mut)
- `verifier_program` (program)
- `nullifier_program` (program)

**Events:**

- `NewCommitment { commitment, leaf_index, encrypted_note }` (×2)

##### `withdraw`

Withdraw tokens from the shielded pool to a public address.

| Param             | Type            | Description                       |
| ----------------- | --------------- | --------------------------------- |
| `root`            | `[u8; 32]`      | Merkle root                       |
| `nullifiers`      | `[[u8; 32]; 2]` | Input nullifiers                  |
| `out_commitments` | `[[u8; 32]; 2]` | Output commitments (change notes) |
| `exit_value`      | `u64`           | Public withdrawal amount          |
| `proof`           | `Vec<u8>`       | Groth16 proof (withdraw circuit)  |

**Accounts:**

- `pool` (mut, PDA)
- `vault` (mut, token account)
- `recipient` (mut)
- `recipient_token_account` (mut)
- `nullifier_registry` (mut)
- `verifier_program`, `nullifier_program`, `token_program`

---

### holanc-verifier

**Program ID:** `GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi`

#### Instructions

##### `initialize_vk`

Store a verification key for a specific circuit type.

| Param          | Type            | Description                                            |
| -------------- | --------------- | ------------------------------------------------------ |
| `circuit_type` | `u8`            | Circuit identifier (0=deposit, 1=transfer, 2=withdraw) |
| `alpha_g1`     | `[u8; 64]`      | VK alpha point (G1)                                    |
| `beta_g2`      | `[u8; 128]`     | VK beta point (G2)                                     |
| `gamma_g2`     | `[u8; 128]`     | VK gamma point (G2)                                    |
| `delta_g2`     | `[u8; 128]`     | VK delta point (G2)                                    |
| `ic`           | `Vec<[u8; 64]>` | IC points (G1) for public inputs                       |

**PDA:** `["vk", circuit_type]`

##### `verify_proof`

Verify a Groth16 proof against a stored verification key.

| Param           | Type            | Description          |
| --------------- | --------------- | -------------------- |
| `circuit_type`  | `u8`            | Circuit identifier   |
| `proof_a`       | `[u8; 64]`      | Proof π_A (G1)       |
| `proof_b`       | `[u8; 128]`     | Proof π_B (G2)       |
| `proof_c`       | `[u8; 64]`      | Proof π_C (G1)       |
| `public_inputs` | `Vec<[u8; 32]>` | Public input scalars |

Returns `Ok(())` if the proof is valid, errors otherwise.

---

### holanc-nullifier

**Program ID:** `BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si`

#### Instructions

##### `initialize_registry`

Create a new nullifier registry.

| Param     | Type  | Description                |
| --------- | ----- | -------------------------- |
| `pool_id` | `u64` | Associated pool identifier |

**PDA:** `["nullifier", pool_id]`

##### `register_nullifier`

Register a nullifier (V1, single-chain).

| Param       | Type       | Description    |
| ----------- | ---------- | -------------- |
| `nullifier` | `[u8; 32]` | Nullifier hash |

Fails if the nullifier is already registered (double-spend attempt).

##### `initialize_epoch`

Initialize epoch tracking for cross-chain sync.

| Param            | Type  | Description           |
| ---------------- | ----- | --------------------- |
| `epoch_duration` | `u64` | Epoch length in slots |

##### `register_nullifier_v2`

Register a domain-separated nullifier (V2, cross-chain).

| Param       | Type       | Description                     |
| ----------- | ---------- | ------------------------------- |
| `nullifier` | `[u8; 32]` | Domain-separated nullifier hash |
| `chain_id`  | `u64`      | Source chain identifier         |
| `app_id`    | `u64`      | Application identifier          |

---

### holanc-bridge

**Program ID:** `H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K`

Cross-chain epoch root synchronization via Wormhole.

#### Instructions

##### `initialize`

Create bridge config for a pool.

| Param      | Type  | Description                                   |
| ---------- | ----- | --------------------------------------------- |
| `chain_id` | `u64` | Local chain ID (1=Solana, 2=Eclipse, 3=Sonic) |

##### `publish_epoch_root`

Publish a finalized epoch root for other chains to consume.

| Param             | Type       | Description           |
| ----------------- | ---------- | --------------------- |
| `epoch`           | `u64`      | Epoch number          |
| `nullifier_root`  | `[u8; 32]` | Nullifier Merkle root |
| `nullifier_count` | `u64`      | Number of nullifiers  |

##### `receive_epoch_root`

Receive and verify a foreign epoch root from another SVM chain.

| Param             | Type       | Description             |
| ----------------- | ---------- | ----------------------- |
| `source_chain`    | `u64`      | Source chain identifier |
| `epoch`           | `u64`      | Epoch number            |
| `nullifier_root`  | `[u8; 32]` | Foreign nullifier root  |
| `nullifier_count` | `u64`      | Number of nullifiers    |
| `vaa_hash`        | `[u8; 32]` | Wormhole VAA hash       |

##### `lock_commitment`

Lock a commitment for cross-chain transfer.

| Param               | Type       | Description             |
| ------------------- | ---------- | ----------------------- |
| `commitment`        | `[u8; 32]` | Commitment to lock      |
| `destination_chain` | `u64`      | Target chain identifier |
| `proof`             | `Vec<u8>`  | Merkle inclusion proof  |

##### `unlock_commitment`

Unlock a commitment received from another chain.

| Param          | Type       | Description                 |
| -------------- | ---------- | --------------------------- |
| `commitment`   | `[u8; 32]` | Commitment to unlock        |
| `source_chain` | `u64`      | Source chain identifier     |
| `proof`        | `Vec<u8>`  | Cross-chain inclusion proof |

---

### holanc-compliance

**Program ID:** `8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE`

Optional compliance hooks for regulated deployments.

#### Instructions

##### `initialize`

Create compliance config for a pool.

| Param  | Type | Description                                         |
| ------ | ---- | --------------------------------------------------- |
| `mode` | `u8` | 0=Permissionless, 1=OptionalDisclosure, 2=Mandatory |

##### `register_oracle`

Register a compliance oracle with specific permissions.

| Param         | Type     | Description         |
| ------------- | -------- | ------------------- |
| `name`        | `String` | Oracle display name |
| `permissions` | `u8`     | Permission bitmap   |

Permission bitmap flags: `ViewBalance=1, ViewTransactions=2, ViewIdentity=4, AttestWealth=8, Freeze=16`

##### `disclose_viewing_key`

User discloses an encrypted viewing key to a registered oracle.

| Param                   | Type      | Description                            |
| ----------------------- | --------- | -------------------------------------- |
| `scope`                 | `u8`      | 0=Full, 1=TimeBounded, 2=AmountBounded |
| `encrypted_viewing_key` | `Vec<u8>` | Encrypted with oracle's key            |
| `valid_from`            | `i64`     | Start timestamp                        |
| `valid_until`           | `i64`     | Expiry timestamp                       |

##### `submit_wealth_proof`

Submit a ZK wealth proof attestation.

| Param          | Type      | Description                       |
| -------------- | --------- | --------------------------------- |
| `threshold`    | `u64`     | Minimum balance proved (lamports) |
| `proof_data`   | `Vec<u8>` | Groth16 proof bytes               |
| `circuit_type` | `u8`      | Circuit ID for wealth proof       |

---

## TypeScript SDK

### HolancClient

```typescript
class HolancClient {
  constructor(
    connection: Connection,
    payer: Keypair,
    config: {
      poolProgramId: string;
      verifierProgramId: string;
      nullifierProgramId: string;
      relayerUrl?: string;
    },
  );

  deposit(wallet: HolancWallet, amount: number): Promise<string>;
  transfer(
    wallet: HolancWallet,
    recipient: string,
    amount: number,
  ): Promise<string>;
  withdraw(
    wallet: HolancWallet,
    recipient: PublicKey,
    amount: number,
  ): Promise<string>;
  getPoolState(poolId: number): Promise<PoolState>;
  syncNotes(wallet: HolancWallet): Promise<void>;
}
```

### HolancWallet

```typescript
class HolancWallet {
  static fromMnemonic(mnemonic: string): HolancWallet;
  static generate(): HolancWallet;

  getBalance(assetId?: string): number;
  getNotes(): ShieldedNote[];
  getHistory(): TransactionRecord[];
  getSpendingPublicKey(): string;
  getViewingKey(): string;
  exportMnemonic(): string;
}
```

### Prover

```typescript
class HolancProver {
  constructor(circuitDir?: string);

  proveDeposit(owner, value, assetId, blinding): Promise<ProveResult>;
  proveTransfer(params: TransferProveParams): Promise<ProveResult>;
  proveWithdraw(params: WithdrawProveParams): Promise<ProveResult>;
  proveTransferV2(params: TransferV2ProveParams): Promise<ProveResult>;
  proveWithdrawV2(params: WithdrawV2ProveParams): Promise<ProveResult>;
  proveStealthTransfer(
    params: StealthTransferProveParams,
  ): Promise<ProveResult>;
  proveWealth(params: WealthProofProveParams): Promise<ProveResult>;
  proveTransfer4x4(params: Transfer4x4ProveParams): Promise<ProveResult>;
  proveWithdraw4x4(params: Withdraw4x4ProveParams): Promise<ProveResult>;
  verifyLocally(circuitName, proof, publicSignals): Promise<boolean>;
}

interface Transfer4x4ProveParams extends TransferProveParams {
  hasInput: boolean[]; // Active input selectors (length 4)
  hasOutput: boolean[]; // Active output selectors (length 4)
}

interface Withdraw4x4ProveParams extends Transfer4x4ProveParams {
  exitValue: bigint; // Public withdrawal amount
}
```

### Stealth Addresses

```typescript
function stealthSend(meta: StealthMetaAddress): StealthSendResult;
function stealthScan(
  ephemeralPubkey: string,
  stealthOwner: string,
  recipientSpendPubkey: string,
  recipientViewPubkey: string,
): StealthScanResult;
function deriveStealthSpendingKey(
  spendingKey: string,
  sharedSecret: string,
): string;
```

### HolancBridge

```typescript
class HolancBridge {
  constructor(connection: Connection, config?: Partial<BridgeConfig>);

  getBridgePda(poolAddress: PublicKey): PublicKey;
  getForeignRootPda(pool, sourceChain, epoch): PublicKey;
  getForeignRoot(sourceChain, epoch): Promise<ForeignEpochRoot | null>;
  getCommitmentLockPda(pool, commitment): PublicKey;
}

enum SvmChain {
  Solana = 1,
  Eclipse = 2,
  Sonic = 3,
}
```

### HolancCompliance

```typescript
class HolancCompliance {
  constructor(connection: Connection, config?: Partial<ComplianceConfig>);

  getCompliancePda(poolAddress: PublicKey): PublicKey;
  getOraclePda(poolAddress, oracle): PublicKey;
  getDisclosurePda(poolAddress, user, oracle): PublicKey;
  getWealthAttestationPda(poolAddress, owner): PublicKey;
  getOracle(oracle: PublicKey): Promise<OracleRecord | null>;
  getWealthAttestation(owner: PublicKey): Promise<WealthAttestation | null>;
  isWealthAttestationValid(owner: PublicKey): Promise<boolean>;
}

enum ComplianceMode {
  Permissionless = 0,
  OptionalDisclosure = 1,
  MandatoryDisclosure = 2,
}
enum DisclosureScope {
  Full = 0,
  TimeBounded = 1,
  AmountBounded = 2,
}
```

---

## Relayer HTTP API

### `GET /health`

Health check endpoint.

**Response:** `{ "status": "ok" }`

### `POST /relay`

Submit a signed transaction for batched relay.

**Request:**

```json
{
  "transaction": "<base64-encoded-signed-transaction>"
}
```

**Response:**

```json
{
  "id": "<uuid>",
  "status": "queued"
}
```

### `GET /relay/:id`

Check status of a relayed transaction.

**Response:**

```json
{
  "id": "<uuid>",
  "status": "queued" | "submitted" | "confirmed" | "failed",
  "signature": "<tx-signature>"
}
```

### `GET /fee`

Get current fee estimate for relayed transactions.

**Response:**

```json
{
  "baseFee": 50000,
  "priorityFee": 1000,
  "totalFee": 51000,
  "unit": "lamports"
}
```

---

## Rust Crates

### holanc-primitives

Core cryptographic building blocks.

```rust
// Poseidon hash
pub fn poseidon_hash(inputs: &[Fr]) -> Fr;
pub fn poseidon_hash_two(a: &Fr, b: &Fr) -> Fr;

// Commitment
pub fn compute_commitment(owner: &Fr, value: u64, asset_id: &Fr, blinding: &Fr) -> Fr;

// Nullifier
pub fn compute_nullifier(spending_key: &Fr, commitment: &Fr) -> Fr;
pub fn compute_nullifier_v2(spending_key: &Fr, commitment: &Fr, chain_id: u64, app_id: u64) -> Fr;

// Envelope (fixed-size padding)
pub fn pad_envelope(data: &[u8]) -> [u8; ENVELOPE_SIZE]; // ENVELOPE_SIZE = 2048
pub fn unpad_envelope(envelope: &[u8; ENVELOPE_SIZE]) -> Vec<u8>;
```

### holanc-note

Note handling and encryption.

```rust
pub struct ShieldedNote {
    pub owner: Fr,
    pub value: u64,
    pub asset_id: Fr,
    pub blinding: Fr,
}

impl ShieldedNote {
    pub fn commitment(&self) -> Fr;
    pub fn encrypt(&self, shared_secret: &[u8]) -> EncryptedNote;
    pub fn decrypt(encrypted: &EncryptedNote, shared_secret: &[u8]) -> Option<Self>;
}

// Stealth addresses
pub fn derive_stealth_owner(recipient_pubkey: &Fr, ephemeral: &Fr) -> Fr;
pub fn scan_note(spending_key: &Fr, spending_pubkey: &Fr, ephemeral_pubkey: &Fr, owner: &Fr) -> bool;
```

### holanc-tree

Merkle tree operations.

```rust
pub struct SparseMerkleTree {
    pub fn new(depth: usize) -> Self;
    pub fn append(&mut self, leaf: Fr) -> usize;  // returns leaf index
    pub fn root(&self) -> Fr;
    pub fn proof(&self, index: usize) -> MerkleProof;
}

pub struct MerkleProof {
    pub path_elements: Vec<Fr>,
    pub path_indices: Vec<bool>,
}
```

### holanc-client

Wallet and transaction building.

```rust
pub struct Wallet {
    pub fn from_mnemonic(mnemonic: &str) -> Result<Self>;
    pub fn deposit(&mut self, value: u64, asset_id: Fr) -> DepositRequest;
    pub fn select_coins(&self, amount: u64) -> Vec<ShieldedNote>;
    pub fn balance(&self) -> u64;
    pub fn history(&self) -> Vec<TransactionRecord>;
}
```
