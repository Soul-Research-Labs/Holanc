//! # holanc-client
//!
//! Client-side wallet for the Holanc privacy protocol.
//! Manages spending/viewing keys, tracks unspent notes, performs coin selection,
//! and prepares transaction inputs for proof generation.

use holanc_note::keys::SpendingKey;
use holanc_note::note::Note;
use holanc_tree::MerkleTree;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WalletError {
    #[error("Insufficient balance: have {have}, need {need}")]
    InsufficientBalance { have: u64, need: u64 },
    #[error("No unspent notes available")]
    NoUnspentNotes,
    #[error("Note not found at index {0}")]
    NoteNotFound(u64),
    #[error("Wallet persistence failed: {0}")]
    PersistenceFailed(String),
    #[error("Merkle tree is full — pool capacity exhausted")]
    TreeFull,
    #[error("Commitment hash failed")]
    CommitmentFailed,
}

/// Transaction record for wallet history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TxRecord {
    Deposit {
        amount: u64,
        leaf_index: u64,
    },
    Send {
        amount: u64,
        fee: u64,
        nullifiers: [[u8; 32]; 2],
    },
    Withdraw {
        amount: u64,
        fee: u64,
        nullifiers: [[u8; 32]; 2],
    },
}

/// The Holanc client wallet.
pub struct Wallet {
    spending_key: SpendingKey,
    notes: Vec<Note>,
    tree: MerkleTree,
    history: Vec<TxRecord>,
    /// The asset ID this wallet tracks (default: all zeros = native SOL).
    asset_id: [u8; 32],
}

impl Wallet {
    /// Create a new wallet from a spending key.
    pub fn new(spending_key: SpendingKey) -> Self {
        Wallet {
            spending_key,
            notes: Vec::new(),
            tree: MerkleTree::default_depth(),
            history: Vec::new(),
            asset_id: [0u8; 32],
        }
    }

    /// Create a wallet from a BIP39 mnemonic.
    pub fn from_mnemonic(mnemonic: &str) -> Self {
        Self::new(SpendingKey::from_mnemonic(mnemonic))
    }

    /// Create a wallet with a random key.
    pub fn random() -> Self {
        Self::new(SpendingKey::random())
    }

    /// Get the spending key bytes (owner identifier).
    pub fn owner(&self) -> &[u8; 32] {
        self.spending_key.as_bytes()
    }

    /// Get the balance of all unspent notes.
    pub fn balance(&self) -> u64 {
        self.notes
            .iter()
            .filter(|n| !n.spent)
            .map(|n| n.value)
            .sum()
    }

    /// Get unspent notes.
    pub fn unspent_notes(&self) -> Vec<&Note> {
        self.notes.iter().filter(|n| !n.spent).collect()
    }

    /// Add a note received from a deposit.
    pub fn add_deposit_note(&mut self, value: u64) -> Result<Note, WalletError> {
        let note = Note::new(*self.owner(), value, self.asset_id);
        let commitment = note.commitment().map_err(|_| WalletError::CommitmentFailed)?;
        let (leaf_index, _root) = self
            .tree
            .append(*commitment.as_bytes())
            .map_err(|_| WalletError::TreeFull)?;

        let mut note = note;
        note.leaf_index = Some(leaf_index);
        self.notes.push(note.clone());

        self.history.push(TxRecord::Deposit {
            amount: value,
            leaf_index,
        });

        Ok(note)
    }

    /// Select notes for spending, returning up to 2 notes that cover the amount.
    /// Uses a simple greedy algorithm: largest notes first.
    pub fn select_notes(&self, amount: u64) -> Result<Vec<&Note>, WalletError> {
        let mut unspent: Vec<&Note> = self.unspent_notes();
        if unspent.is_empty() {
            return Err(WalletError::NoUnspentNotes);
        }

        // Sort by value descending
        unspent.sort_by(|a, b| b.value.cmp(&a.value));

        let total: u64 = unspent.iter().map(|n| n.value).sum();
        if total < amount {
            return Err(WalletError::InsufficientBalance {
                have: total,
                need: amount,
            });
        }

        // Greedy: pick notes until we cover the amount (max 2 for 2-in-2-out circuit)
        let mut selected = Vec::new();
        let mut covered = 0u64;
        for note in unspent {
            if covered >= amount {
                break;
            }
            selected.push(note);
            covered += note.value;
            if selected.len() >= 2 {
                break;
            }
        }

        if covered < amount {
            return Err(WalletError::InsufficientBalance {
                have: covered,
                need: amount,
            });
        }

        Ok(selected)
    }

    /// Get the Merkle tree (for proof generation).
    pub fn tree(&self) -> &MerkleTree {
        &self.tree
    }

    /// Get transaction history.
    pub fn history(&self) -> &[TxRecord] {
        &self.history
    }

    /// Get the spending key reference.
    pub fn spending_key(&self) -> &SpendingKey {
        &self.spending_key
    }

    /// Prepare input/output notes for a private transfer.
    ///
    /// Returns (input_notes, output_notes, input_proofs) ready for proof generation.
    pub fn prepare_transfer(
        &self,
        recipient_owner: [u8; 32],
        amount: u64,
        fee: u64,
    ) -> Result<PreparedTransfer, WalletError> {
        let total = amount.checked_add(fee).ok_or(WalletError::InsufficientBalance {
            have: self.balance(),
            need: u64::MAX,
        })?;
        let selected = self.select_notes(total)?;
        let input_sum: u64 = selected.iter().map(|n| n.value).sum();
        let change = input_sum - total;

        // Build input notes array (padded to 2)
        let mut input_notes = [
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32]),
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32]),
        ];
        let mut input_proofs = Vec::new();

        for (i, note) in selected.iter().enumerate() {
            input_notes[i] = (*note).clone();
            if let Some(idx) = note.leaf_index {
                input_proofs.push(
                    self.tree
                        .proof(idx)
                        .map_err(|e| WalletError::NoteNotFound(idx))?,
                );
            } else {
                return Err(WalletError::NoteNotFound(0));
            }
        }
        // Pad proofs if only 1 input
        while input_proofs.len() < 2 {
            input_proofs.push(holanc_tree::MerkleProof {
                leaf_index: 0,
                path_elements: vec![[0u8; 32]; 20],
                path_indices: vec![0u8; 20],
                root: self.tree.root(),
            });
        }

        // Build output notes
        let recipient_note = Note::new(recipient_owner, amount, self.asset_id);
        let change_note = if change > 0 {
            Note::new(*self.owner(), change, self.asset_id)
        } else {
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32])
        };

        Ok(PreparedTransfer {
            input_notes,
            output_notes: [recipient_note, change_note],
            input_proofs: [input_proofs[0].clone(), input_proofs[1].clone()],
            fee,
        })
    }

    /// Prepare input/output notes for a withdrawal.
    pub fn prepare_withdraw(
        &self,
        amount: u64,
        fee: u64,
    ) -> Result<PreparedWithdraw, WalletError> {
        let total = amount.checked_add(fee).ok_or(WalletError::InsufficientBalance {
            have: self.balance(),
            need: u64::MAX,
        })?;
        let selected = self.select_notes(total)?;
        let input_sum: u64 = selected.iter().map(|n| n.value).sum();
        let change = input_sum - total;

        let mut input_notes = [
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32]),
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32]),
        ];
        let mut input_proofs = Vec::new();

        for (i, note) in selected.iter().enumerate() {
            input_notes[i] = (*note).clone();
            if let Some(idx) = note.leaf_index {
                input_proofs.push(
                    self.tree
                        .proof(idx)
                        .map_err(|e| WalletError::NoteNotFound(idx))?,
                );
            } else {
                return Err(WalletError::NoteNotFound(0));
            }
        }
        while input_proofs.len() < 2 {
            input_proofs.push(holanc_tree::MerkleProof {
                leaf_index: 0,
                path_elements: vec![[0u8; 32]; 20],
                path_indices: vec![0u8; 20],
                root: self.tree.root(),
            });
        }

        let change_note = if change > 0 {
            Note::new(*self.owner(), change, self.asset_id)
        } else {
            Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32])
        };

        Ok(PreparedWithdraw {
            input_notes,
            output_notes: [
                change_note,
                Note::with_blinding([0u8; 32], 0, self.asset_id, [0u8; 32]),
            ],
            input_proofs: [input_proofs[0].clone(), input_proofs[1].clone()],
            exit_value: amount,
            fee,
        })
    }

    /// Mark notes as spent by their leaf indices.
    pub fn mark_spent(&mut self, leaf_indices: &[u64]) {
        for note in self.notes.iter_mut() {
            if let Some(idx) = note.leaf_index {
                if leaf_indices.contains(&idx) {
                    note.spent = true;
                }
            }
        }
    }

    /// Save the wallet state to an encrypted file.
    ///
    /// The spending key is used to derive the encryption key via HKDF.
    /// Format: 12-byte nonce || ciphertext (ChaCha20-Poly1305)
    pub fn save(&self, path: &std::path::Path) -> Result<(), WalletError> {
        let state = WalletState {
            spending_key: *self.spending_key.as_bytes(),
            notes: self.notes.clone(),
            history: self.history.clone(),
            asset_id: self.asset_id,
        };
        let plaintext = serde_json::to_vec(&state)
            .map_err(|e| WalletError::PersistenceFailed(e.to_string()))?;

        let (ciphertext, nonce) =
            holanc_note::encryption::encrypt_note(self.spending_key.as_bytes(), &plaintext)
                .map_err(|e| WalletError::PersistenceFailed(e.to_string()))?;

        let mut out = Vec::with_capacity(12 + ciphertext.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ciphertext);

        std::fs::write(path, &out)
            .map_err(|e| WalletError::PersistenceFailed(e.to_string()))?;
        Ok(())
    }

    /// Load wallet state from an encrypted file.
    ///
    /// The provided spending key decrypts the file. Fails if the key is wrong.
    pub fn load(path: &std::path::Path, spending_key: SpendingKey) -> Result<Self, WalletError> {
        let data = std::fs::read(path)
            .map_err(|e| WalletError::PersistenceFailed(e.to_string()))?;
        if data.len() < 12 {
            return Err(WalletError::PersistenceFailed("file too short".into()));
        }
        let nonce: [u8; 12] = data[..12].try_into().unwrap();
        let ciphertext = &data[12..];

        let plaintext =
            holanc_note::encryption::decrypt_note(spending_key.as_bytes(), ciphertext, &nonce)
                .map_err(|_| WalletError::PersistenceFailed("decryption failed (wrong key?)".into()))?;

        let state: WalletState = serde_json::from_slice(&plaintext)
            .map_err(|e| WalletError::PersistenceFailed(e.to_string()))?;

        let mut wallet = Wallet::new(spending_key);
        wallet.notes = state.notes;
        wallet.history = state.history;
        wallet.asset_id = state.asset_id;

        // Rebuild the Merkle tree from persisted notes
        for note in &wallet.notes {
            if let Some(_) = note.leaf_index {
                if let Ok(cm) = note.commitment() {
                    let _ = wallet.tree.append(*cm.as_bytes());
                }
            }
        }

        Ok(wallet)
    }
}

/// Prepared transfer data, ready for proof generation.
pub struct PreparedTransfer {
    pub input_notes: [Note; 2],
    pub output_notes: [Note; 2],
    pub input_proofs: [holanc_tree::MerkleProof; 2],
    pub fee: u64,
}

/// Prepared withdrawal data, ready for proof generation.
pub struct PreparedWithdraw {
    pub input_notes: [Note; 2],
    pub output_notes: [Note; 2],
    pub input_proofs: [holanc_tree::MerkleProof; 2],
    pub exit_value: u64,
    pub fee: u64,
}

/// Serializable wallet state for encrypted persistence.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WalletState {
    spending_key: [u8; 32],
    notes: Vec<Note>,
    history: Vec<TxRecord>,
    asset_id: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wallet_deposit_and_balance() {
        let mut wallet = Wallet::random();
        assert_eq!(wallet.balance(), 0);

        wallet.add_deposit_note(100);
        assert_eq!(wallet.balance(), 100);

        wallet.add_deposit_note(50);
        assert_eq!(wallet.balance(), 150);
    }

    #[test]
    fn test_coin_selection() {
        let mut wallet = Wallet::random();
        wallet.add_deposit_note(100);
        wallet.add_deposit_note(50);
        wallet.add_deposit_note(30);

        // Should select the 100 note
        let selected = wallet.select_notes(80).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].value, 100);

        // Should select 100 + 50
        let selected = wallet.select_notes(120).unwrap();
        assert_eq!(selected.len(), 2);
    }

    #[test]
    fn test_insufficient_balance() {
        let mut wallet = Wallet::random();
        wallet.add_deposit_note(50);
        assert!(wallet.select_notes(100).is_err());
    }

    #[test]
    fn test_history() {
        let mut wallet = Wallet::random();
        wallet.add_deposit_note(100);
        assert_eq!(wallet.history().len(), 1);
        match &wallet.history()[0] {
            TxRecord::Deposit { amount, .. } => assert_eq!(*amount, 100),
            _ => panic!("Expected deposit record"),
        }
    }
}
