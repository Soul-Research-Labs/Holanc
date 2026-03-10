# Protocol Specification

## 1. Commitment Scheme

Holanc uses the Poseidon hash function over the BN254 scalar field for all commitment and nullifier derivations.

### Note Commitment

```
commitment = Poseidon(owner_pubkey, value, asset_id, blinding)
```

| Field        | Size    | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| owner_pubkey | 256 bit | Recipient's spending public key              |
| value        | 64 bit  | Token amount (unsigned)                      |
| asset_id     | 256 bit | SPL token mint address (or 0 for native SOL) |
| blinding     | 254 bit | Random BN254 scalar (hiding factor)          |

The commitment is computationally hiding (via the random blinding) and binding (collision resistance of Poseidon).

### Commitment Tree

Commitments are appended to a Merkle tree of depth 20, yielding a maximum capacity of 2^20 = 1,048,576 notes.

- Hash function: Poseidon-2 (binary Merkle)
- Zero values: Pre-computed chain of zeros at each level
- Root history: Ring buffer of 100 recent roots stored on-chain, allowing proofs against slightly stale roots

## 2. Nullifier Derivation

### V1 (Single-Chain)

```
nullifier = Poseidon(spending_key, commitment)
```

Deterministic: given a spending key and commitment, there is exactly one valid nullifier. This prevents double-spending — attempting to spend the same note twice will produce the same nullifier, which the on-chain registry will reject.

### V2 (Cross-Chain / Domain-Separated)

```
domain = Poseidon(chain_id, app_id)
nullifier = Poseidon(Poseidon(spending_key, commitment), domain)
```

V2 nullifiers ensure the same note produces different nullifiers across different chains or applications. This enables:

- Independent privacy sets per SVM chain (Solana, Eclipse, Sonic)
- Application-specific nullifier namespaces
- Cross-chain double-spend prevention via epoch root synchronization

## 3. Key Management

### Spending Key Pair

The spending key is derived from a BIP-39 mnemonic:

```
seed = BIP39(mnemonic)
spending_key = HKDF-SHA256(seed, "holanc-spending-key")
spending_pubkey = Poseidon(spending_key)
```

The spending key authorizes note consumption (it's required to derive the correct nullifier).

### Viewing Key

```
viewing_key = HKDF-SHA256(seed, "holanc-viewing-key")
```

The viewing key decrypts incoming notes (trial decryption) without spending authority. Used by wallets and indexers to track balance.

### Stealth Addresses

For enhanced recipient privacy:

```
ephemeral = random BN254 scalar
shared_secret = ECDH(ephemeral, recipient_pubkey)
stealth_owner = Poseidon(recipient_spending_key, shared_secret)
```

The ephemeral public key is included in the encrypted note data. Recipients scanning for incoming notes derive the same shared secret using their private key.

## 4. Encryption

Note plaintext is encrypted before being emitted as a program log:

```
key = HKDF-SHA256(shared_secret || ephemeral_pubkey, "holanc-note-encryption")
nonce = first 12 bytes of SHA256(commitment)
ciphertext = ChaCha20-Poly1305(key, nonce, note_plaintext)
```

The encrypted note is padded to a fixed 2048-byte envelope to prevent metadata leakage from ciphertext size.

## 5. Circuit Constraints

### Deposit Circuit

Public inputs: `commitment`
Private inputs: `owner, value, asset_id, blinding`

Constraints:

1. `commitment == Poseidon(owner, value, asset_id, blinding)` — commitment validity
2. `value > 0` — non-zero deposit
3. `value < 2^64` — 64-bit range check

### Transfer Circuit

Public inputs: `root, nullifier_0, nullifier_1, out_commitment_0, out_commitment_1`
Private inputs: `in_note_0, in_note_1, in_path_0, in_path_1, out_note_0, out_note_1, spending_key`

Constraints:

1. For each input:
   - `commitment_i == Poseidon(owner_i, value_i, asset_id_i, blinding_i)` — note well-formed
   - `MerkleProof(root, commitment_i, path_i)` — inclusion in tree
   - `nullifier_i == Poseidon(spending_key, commitment_i)` — correct nullifier
   - `owner_i == Poseidon(spending_key)` — ownership proof
2. For each output:
   - `out_commitment_i == Poseidon(out_owner_i, out_value_i, out_asset_id_i, out_blinding_i)`
   - `out_value_i < 2^64` — range check
3. Value conservation: `in_value_0 + in_value_1 == out_value_0 + out_value_1`

### Withdraw Circuit

Extends the transfer circuit with an additional public `exit_value` output:

Public inputs: `root, nullifier_0, nullifier_1, out_commitment_0, out_commitment_1, exit_value`

Additional constraint:

- `in_value_0 + in_value_1 == out_value_0 + out_value_1 + exit_value` — value conservation with public withdrawal

## 6. Transaction Flow

### Deposit

1. Client generates random blinding, computes commitment
2. Client generates deposit proof (commitment validity)
3. Transaction: `pool::deposit(amount, commitment, proof)` — verifier checks proof, tokens transferred to vault, commitment appended to tree

### Private Transfer

1. Client selects input notes (coin selection: largest-first)
2. Client computes nullifiers, constructs output notes
3. Client generates transfer proof
4. Transaction submitted via relayer: `pool::transfer(root, nullifiers, out_commitments, proof, encrypted_notes)`
5. Verifier checks proof, nullifiers registered, commitments appended, encrypted notes emitted as logs

### Withdrawal

1. Same as transfer, but one output is the exit value
2. Transaction: `pool::withdraw(root, nullifiers, out_commitments, exit_value, recipient, proof)`
3. After verification, `exit_value` tokens transferred from vault to `recipient`

## 7. Metadata Resistance

### Fixed-Size Envelopes

All note payloads are padded to exactly 2048 bytes regardless of content. This prevents observers from distinguishing deposit/transfer/withdraw by payload size.

### Batched Relay

The relayer collects transactions and submits them in batches. Batches are padded with dummy transactions to maintain a minimum batch size, providing k-anonymity within each batch.

### Timing Jitter

Transaction relay is delayed by a random duration sampled from a truncated exponential distribution (base 200ms, mean 1s, max 5s). This decorrelates client submission time from on-chain confirmation time.
