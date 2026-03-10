//! # holanc-note
//!
//! Note model, key hierarchy, ECDH-based encryption, and stealth addresses
//! for the Holanc privacy protocol.

pub mod encryption;
pub mod keys;
pub mod note;
pub mod stealth;

pub use keys::{SpendingKey, ViewingKey};
pub use note::Note;
