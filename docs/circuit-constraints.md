# Circuit Constraints Reference

## Shared Components (lib/common.circom)

### Poseidon Hash

Used throughout for commitment computation, nullifier derivation, and Merkle hashing.

```
template Poseidon(nInputs)
```

Native circomlib Poseidon over BN254 scalar field. Width ∈ {2, 3, 4, 5}.

### MerkleProof

```
template MerkleProof(depth)
```

Verifies a Merkle inclusion proof for a given leaf and root.

**Inputs:**

- `leaf` — the commitment hash
- `pathElements[depth]` — sibling hashes along the path
- `pathIndices[depth]` — left/right direction bits (0 or 1)
- `root` — expected Merkle root (public)

**Constraints:**

- For each level `i`: selector routes left/right based on `pathIndices[i]`, then hashes the pair via Poseidon-2
- Final computed root must equal the public `root` input
- Each `pathIndices[i]` is boolean-constrained

**Constraint count:** ~150 × depth (primarily Poseidon hashes)

### NullifierDerive

```
template NullifierDerive()
```

**Inputs:**

- `spendingKey` — private spending key
- `commitment` — note commitment hash

**Output:**

- `nullifier = Poseidon(spendingKey, commitment)`

### CommitmentCompute

```
template CommitmentCompute()
```

**Inputs:**

- `owner` — owner public key
- `value` — token amount
- `assetId` — token mint identifier
- `blinding` — random blinding factor

**Output:**

- `commitment = Poseidon(owner, value, assetId, blinding)`

---

## Deposit Circuit (deposit.circom)

**Purpose:** Prove that a public commitment corresponds to a valid note without revealing the note contents.

### Signals

| Signal       | Visibility | Description            |
| ------------ | ---------- | ---------------------- |
| `commitment` | public     | Note commitment hash   |
| `owner`      | private    | Owner public key       |
| `value`      | private    | Deposit amount         |
| `assetId`    | private    | Token mint             |
| `blinding`   | private    | Random blinding factor |

### Constraints

1. **Commitment validity:**

   ```
   Poseidon(owner, value, assetId, blinding) === commitment
   ```

2. **Non-zero value:**

   ```
   value !== 0   (enforced via IsZero + assert)
   ```

3. **64-bit range check:**
   ```
   Num2Bits(64)(value)   // constrains value < 2^64
   ```

**Total constraints:** ~700

---

## Transfer Circuit (transfer.circom)

**Purpose:** Prove private transfer of value between shielded notes — consuming 2 input notes and creating 2 output notes — without revealing amounts, owners, or the link between inputs and outputs.

### Signals

| Signal                  | Visibility | Description             |
| ----------------------- | ---------- | ----------------------- |
| `root`                  | public     | Merkle tree root        |
| `nullifier[2]`          | public     | Input nullifiers        |
| `outCommitment[2]`      | public     | Output commitments      |
| `inValue[2]`            | private    | Input note values       |
| `inOwner[2]`            | private    | Input note owners       |
| `inAssetId[2]`          | private    | Input asset IDs         |
| `inBlinding[2]`         | private    | Input blindings         |
| `inPathElements[2][20]` | private    | Merkle proof siblings   |
| `inPathIndices[2][20]`  | private    | Merkle proof directions |
| `spendingKey`           | private    | Spender's private key   |
| `outValue[2]`           | private    | Output note values      |
| `outOwner[2]`           | private    | Output note owners      |
| `outAssetId[2]`         | private    | Output asset IDs        |
| `outBlinding[2]`        | private    | Output blindings        |

### Constraints

**For each input note (i = 0, 1):**

1. **Commitment reconstruction:**

   ```
   cm_i = Poseidon(inOwner[i], inValue[i], inAssetId[i], inBlinding[i])
   ```

2. **Ownership proof:**

   ```
   Poseidon(spendingKey) === inOwner[i]
   ```

3. **Nullifier derivation:**

   ```
   Poseidon(spendingKey, cm_i) === nullifier[i]
   ```

4. **Merkle inclusion:**
   ```
   MerkleProof(20)(cm_i, inPathElements[i], inPathIndices[i]) === root
   ```

**For each output note (j = 0, 1):**

5. **Output commitment:**

   ```
   Poseidon(outOwner[j], outValue[j], outAssetId[j], outBlinding[j]) === outCommitment[j]
   ```

6. **64-bit range check:**
   ```
   Num2Bits(64)(outValue[j])
   ```

**Global:**

7. **Value conservation:**
   ```
   inValue[0] + inValue[1] === outValue[0] + outValue[1]
   ```

**Total constraints:** ~8,000

---

## Withdraw Circuit (withdraw.circom)

**Purpose:** Extends the transfer circuit to allow a public exit value, enabling withdrawal of tokens from the shielded pool to a public address.

### Additional Signals

| Signal      | Visibility | Description               |
| ----------- | ---------- | ------------------------- |
| `exitValue` | public     | Amount withdrawn publicly |

### Modified Constraint

**Value conservation with exit:**

```
inValue[0] + inValue[1] === outValue[0] + outValue[1] + exitValue
```

All other constraints are identical to the transfer circuit.

**Total constraints:** ~8,100

---

## Transfer V2 Circuit (transfer_v2.circom)

**Purpose:** Same as the transfer circuit with domain-separated nullifiers for cross-chain safety. Nullifiers include a chain_id and app_id to prevent cross-chain replay.

### Additional Signals

| Signal     | Visibility | Description                  |
| ---------- | ---------- | ---------------------------- |
| `chain_id` | public     | Target blockchain identifier |
| `app_id`   | public     | Application/pool identifier  |

### Modified Constraint

**Domain-separated nullifier derivation (NullifierV2):**

```
domain = Poseidon(chain_id, app_id)
base_nullifier = Poseidon(spendingKey, commitment)
nullifier = Poseidon(base_nullifier, domain)
```

All other constraints are identical to the transfer circuit.

**Total constraints:** ~8,400

---

## Withdraw V2 Circuit (withdraw_v2.circom)

Same as withdraw + V2 domain-separated nullifiers. Additional `chain_id` and `app_id` public inputs.

**Total constraints:** ~8,500

---

## Stealth Transfer Circuit (stealth_transfer.circom)

**Purpose:** Extends the transfer circuit with ephemeral key derivation constraints for stealth addresses. The sender proves the output note is owned by a stealth address derived from the recipient's public key.

### Additional Signals

| Signal                      | Visibility | Description                 |
| --------------------------- | ---------- | --------------------------- |
| `ephemeral_pubkey`          | public     | Hash of ephemeral key       |
| `ephemeral_key`             | private    | Sender's ephemeral secret   |
| `recipient_spending_pubkey` | private    | Recipient's spending pubkey |

### Additional Constraints

1. **Ephemeral public key derivation:**

   ```
   Poseidon(ephemeral_key) === ephemeral_pubkey
   ```

2. **Shared secret derivation:**

   ```
   shared_secret = Poseidon(ephemeral_key, recipient_spending_pubkey)
   ```

3. **Stealth owner derivation:**
   ```
   stealth_owner = Poseidon(recipient_spending_pubkey, shared_secret)
   outOwner[0] === stealth_owner
   ```

**Total constraints:** ~8,800

---

## Wealth Proof Circuit (wealth_proof.circom)

**Purpose:** Prove that the total balance across up to 8 shielded notes exceeds a public threshold, without revealing the exact balance or which notes are owned.

### Signals

| Signal                        | Visibility | Description            |
| ----------------------------- | ---------- | ---------------------- |
| `merkle_root`                 | public     | Current Merkle root    |
| `threshold`                   | public     | Minimum balance        |
| `owner_commitment`            | public     | Poseidon(spending_key) |
| `spending_key`                | private    | Owner's spending key   |
| `note_value[8]`               | private    | Note values            |
| `note_blinding[8]`            | private    | Note blindings         |
| `note_asset_id[8]`            | private    | Note asset IDs         |
| `has_note[8]`                 | private    | Active note selector   |
| `merkle_path_elements[8][20]` | private    | Merkle proofs          |
| `merkle_path_indices[8][20]`  | private    | Merkle proof indices   |

### Constraints

1. **Owner commitment check:**

   ```
   Poseidon(spending_key) === owner_commitment
   ```

2. **Per-note (i = 0..7):**

   - `has_note[i]` is boolean
   - `effective_value[i] = note_value[i] * has_note[i]`
   - If active: commitment reconstructed, Merkle inclusion verified, ownership proven
   - 64-bit range checks on each `effective_value[i]`

3. **Balance threshold:**
   ```
   total_balance = Σ effective_value[i]
   diff = total_balance - threshold
   Num2Bits(64)(diff)   // proves diff ≥ 0 (i.e. balance ≥ threshold)
   ```

**Total constraints:** ~35,000 (primarily 8× Merkle proofs)

---

## Transfer 4×4 Circuit (transfer_4x4.circom)

**Purpose:** Generalized variable I/O transfer supporting up to 4 inputs and 4 outputs. Boolean selectors (`has_input`, `has_output`) allow using fewer slots while satisfying the fixed circuit interface.

### Signals

| Signal                        | Visibility | Description             |
| ----------------------------- | ---------- | ----------------------- |
| `merkle_root`                 | public     | Current Merkle root     |
| `nullifiers[4]`               | public     | Input nullifiers        |
| `output_commitments[4]`       | public     | Output commitments      |
| `fee`                         | public     | Relayer fee             |
| `spending_key`                | private    | Spender’s private key   |
| `value[4]`                    | private    | Input note values       |
| `blinding[4]`                 | private    | Input blindings         |
| `asset_id[4]`                 | private    | Input asset IDs         |
| `has_input[4]`                | private    | Active input selector   |
| `merkle_path_elements[4][20]` | private    | Merkle proof siblings   |
| `merkle_path_indices[4][20]`  | private    | Merkle proof directions |
| `output_owner[4]`             | private    | Output note owners      |
| `output_value[4]`             | private    | Output note values      |
| `output_blinding[4]`          | private    | Output blindings        |
| `output_asset_id[4]`          | private    | Output asset IDs        |
| `has_output[4]`               | private    | Active output selector  |

### Constraints

1. **Boolean selectors:** `has_input[i] * (has_input[i] - 1) === 0` (same for `has_output`)
2. **Effective value:** `effective_value[i] = value[i] * has_input[i]`
3. **Per active input:** Commitment, ownership, nullifier, and Merkle proof (gated by `has_input[i]`)
4. **Asset ID consistency:** `(asset_id[i] - asset_id[0]) * has_input[i] === 0`
5. **Per active output:** Commitment and 64-bit range check (gated by `has_output[j]`)
6. **Value conservation:** `Σ effective_in[i] === Σ effective_out[j] + fee`

**Total constraints:** ~16,000

---

## Withdraw 4×4 Circuit (withdraw_4x4.circom)

**Purpose:** Extends the transfer 4×4 circuit with a public `exit_value` for on-chain token release.

### Additional Signals

| Signal       | Visibility | Description               |
| ------------ | ---------- | ------------------------- |
| `exit_value` | public     | Amount withdrawn publicly |

### Modified Constraint

**Value conservation with exit:**

```
Σ effective_in[i] === Σ effective_out[j] + exit_value + fee
```

All other constraints are identical to the transfer 4×4 circuit.

**Total constraints:** ~16,100

---

## Constraint Budget

Solana's compute unit budget imposes limits on proof verification, not on circuit size (proofs are generated off-chain). Groth16 verification cost is constant regardless of circuit complexity:

| Operation                     | Compute Units    |
| ----------------------------- | ---------------- |
| G1 addition (alt_bn128)       | ~200             |
| G1 scalar mul (alt_bn128)     | ~8,000           |
| Pairing check (alt_bn128)     | ~150,000         |
| Full Groth16 verify (typical) | ~200,000-400,000 |

The 1.4M compute unit limit per transaction accommodates all circuit verification costs.
