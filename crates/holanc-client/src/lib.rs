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
    pub fn add_deposit_note(&mut self, value: u64) -> Note {
        let note = Note::new(*self.owner(), value, self.asset_id);
        let commitment = note.commitment();
        let (leaf_index, _root) = self
            .tree
            .append(*commitment.as_bytes())
            .expect("tree should not be full");

        let mut note = note;
        note.leaf_index = Some(leaf_index);
        self.notes.push(note.clone());

        self.history.push(TxRecord::Deposit {
            amount: value,
            leaf_index,
        });

        note
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
