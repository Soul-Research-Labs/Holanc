# Stealth Addresses

## Overview

Stealth addresses allow a sender to generate a one-time address for the recipient, such that:

- Only the recipient can detect and spend notes sent to their stealth address
- An observer cannot link stealth addresses to the recipient's public key
- The recipient can scan for incoming notes without revealing their identity

## Protocol

### Key Setup

Each user has two key pairs derived from their BIP-39 mnemonic:

```
seed = BIP39(mnemonic)
spending_key = HKDF-SHA256(seed, "holanc-spending-key")
spending_pubkey = Poseidon(spending_key)

viewing_key = HKDF-SHA256(seed, "holanc-viewing-key")
viewing_pubkey = Poseidon(viewing_key)
```

The **spending key** authorizes note consumption. The **viewing key** enables detection of incoming notes.

### Sending to a Stealth Address

1. Sender generates an ephemeral scalar:

   ```
   ephemeral = random_bn254_scalar()
   ephemeral_pubkey = Poseidon(ephemeral)
   ```

2. Sender computes the shared secret:

   ```
   shared_secret = Poseidon(ephemeral, recipient_spending_pubkey)
   ```

3. Sender derives the stealth owner (one-time address):

   ```
   stealth_owner = Poseidon(recipient_spending_pubkey, shared_secret)
   ```

4. Sender creates the note with `owner = stealth_owner` and includes `ephemeral_pubkey` in the encrypted note metadata.

### Receiving (Scanning)

The recipient scans encrypted notes from the indexer:

1. For each encrypted note, extract the `ephemeral_pubkey` from the metadata
2. Recompute the shared secret:

   ```
   shared_secret = Poseidon(ephemeral_pubkey, spending_key)
   ```

   Note: This works because `Poseidon(ephemeral, spending_pubkey) = Poseidon(ephemeral_pubkey, spending_key)` when using a commutative variant, or the sender encrypts the shared secret directly.

3. Derive the expected stealth owner:

   ```
   expected_owner = Poseidon(spending_pubkey, shared_secret)
   ```

4. If the note's owner matches `expected_owner`, the note belongs to this recipient

### Spending from a Stealth Address

To spend a stealth note, the recipient needs to prove ownership in the ZK circuit:

```
stealth_spending_key = Poseidon(spending_key, shared_secret)
```

The circuit verifies:

```
Poseidon(stealth_spending_key) === note.owner  // i.e., stealth_owner
```

## Implementation

### Note Encryption with Stealth Metadata

```typescript
interface EncryptedNote {
  ciphertext: Uint8Array; // ChaCha20-Poly1305 encrypted note
  ephemeralPubkey: Uint8Array; // For stealth address scanning
}
```

The `ephemeral_pubkey` is stored in plaintext alongside the ciphertext. It does not reveal the recipient's identity — only the recipient (with their spending key) can derive the correct shared secret to recover the stealth owner.

### Rust Implementation (holanc-note crate)

```rust
pub fn derive_stealth_owner(
    recipient_pubkey: &Fr,
    ephemeral_scalar: &Fr,
) -> Fr {
    let shared = poseidon_hash(&[*ephemeral_scalar, *recipient_pubkey]);
    poseidon_hash(&[*recipient_pubkey, shared])
}

pub fn scan_note(
    spending_key: &Fr,
    spending_pubkey: &Fr,
    ephemeral_pubkey: &Fr,
    note_owner: &Fr,
) -> bool {
    let shared = poseidon_hash(&[*ephemeral_pubkey, *spending_key]);
    let expected = poseidon_hash(&[*spending_pubkey, shared]);
    expected == *note_owner
}
```

## Privacy Properties

| Property                | Status                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| Recipient unlinkability | Stealth owner is unique per transaction                          |
| Sender privacy          | Ephemeral key is random, reveals nothing about sender            |
| Scanning efficiency     | Linear in total notes (trial decryption required)                |
| Spending authority      | Only recipient with spending_key can derive stealth_spending_key |

## Limitations

1. **Linear scanning**: Recipients must trial-decrypt every note. For high-throughput chains, this may require optimized scanning (e.g., tag-based filtering in Phase 2).
2. **Viewing key trade-off**: Sharing the viewing key enables note detection but also reveals stealth address ownership to the viewer.
3. **Commutative hash assumption**: The protocol relies on a specific construction where sender and recipient can independently derive the same shared secret. The current implementation uses a simplified scheme; a production version should use proper ECDH over BabyJubJub or a similar group.
