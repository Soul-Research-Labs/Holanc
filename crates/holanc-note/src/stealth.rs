//! Stealth address protocol for Holanc using BabyJubJub ECDH.
//!
//! Allows a sender to create a one-time payment address for the recipient
//! without the recipient needing to publish a fresh address for each transaction.
//!
//! Protocol (BabyJubJub ECDH):
//!   1. Recipient publishes a stealth meta-address (viewing_pubkey, spending_pubkey).
//!      - viewing_pubkey = viewing_key * G  (BabyJubJub point)
//!      - spending_pubkey = Poseidon(spending_key)  (field element)
//!   2. Sender generates ephemeral scalar r, computes R = r * G.
//!   3. Sender computes shared_point = r * viewing_pubkey (ECDH).
//!   4. Sender derives shared_secret = Poseidon(shared_point.x, shared_point.y).
//!   5. Sender derives one_time_owner = Poseidon(spending_pubkey, shared_secret).
//!   6. Sender publishes R alongside the encrypted note.
//!   7. Recipient scans: shared_point = viewing_key * R (commutativity!),
//!      shared_secret = Poseidon(shared_point.x, shared_point.y),
//!      then checks Poseidon(spending_pubkey, shared_secret) == note.owner.

use ark_ec::{AffineRepr, CurveGroup, Group};
use ark_ed_on_bn254::{EdwardsAffine, EdwardsProjective};
use ark_ff::{BigInteger, PrimeField, UniformRand};
use ark_std::Zero;
use holanc_primitives::poseidon::poseidon_hash;
use thiserror::Error;

/// BabyJubJub base field = BN254 scalar field (used for point coordinates).
type BaseField = <EdwardsAffine as AffineRepr>::BaseField;
/// BabyJubJub scalar field (used for secret scalars / ephemeral keys).
type ScalarField = <EdwardsAffine as AffineRepr>::ScalarField;

#[derive(Debug, Error)]
pub enum StealthError {
    #[error("Stealth address derivation failed")]
    DerivationFailed,
    #[error("Invalid point encoding")]
    InvalidPoint,
}

/// A stealth meta-address published by the recipient.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StealthMetaAddress {
    /// The viewing public key — BabyJubJub point (x, y) as two 32-byte BE arrays.
    pub viewing_pubkey: [[u8; 32]; 2],
    /// The spending public key — Poseidon(spending_key) field element.
    pub spending_pubkey: [u8; 32],
}

/// Result of stealth address generation (sender side).
#[derive(Debug, Clone)]
pub struct StealthSendResult {
    /// The one-time owner field element (used as note.owner).
    pub one_time_owner: [u8; 32],
    /// The shared secret scalar (used for note encryption).
    pub shared_secret: [u8; 32],
    /// The ephemeral public key — BabyJubJub point (x, y) as two 32-byte BE arrays.
    pub ephemeral_pubkey: [[u8; 32]; 2],
}

/// Convert a BabyJubJub affine point to a pair of 32-byte BE coordinate arrays.
fn point_to_bytes(point: &EdwardsAffine) -> [[u8; 32]; 2] {
    let x_bigint: <BaseField as PrimeField>::BigInt = point.x.into();
    let y_bigint: <BaseField as PrimeField>::BigInt = point.y.into();
    let mut x_bytes = [0u8; 32];
    let mut y_bytes = [0u8; 32];
    let x_be = x_bigint.to_bytes_be();
    let y_be = y_bigint.to_bytes_be();
    x_bytes[32 - x_be.len()..].copy_from_slice(&x_be);
    y_bytes[32 - y_be.len()..].copy_from_slice(&y_be);
    [x_bytes, y_bytes]
}

/// Parse a BabyJubJub affine point from two 32-byte BE coordinate arrays.
fn bytes_to_point(coords: &[[u8; 32]; 2]) -> Result<EdwardsAffine, StealthError> {
    let x = BaseField::from_be_bytes_mod_order(&coords[0]);
    let y = BaseField::from_be_bytes_mod_order(&coords[1]);
    let point = EdwardsAffine::new_unchecked(x, y);
    if !point.is_on_curve() || point.is_zero() {
        return Err(StealthError::InvalidPoint);
    }
    Ok(point)
}

/// Sender: generate a stealth address for a recipient using BabyJubJub ECDH.
pub fn stealth_send(
    recipient_meta: &StealthMetaAddress,
) -> Result<StealthSendResult, StealthError> {
    let mut rng = rand::thread_rng();

    // Parse recipient's viewing pubkey as a BabyJubJub point
    let viewing_pubkey = bytes_to_point(&recipient_meta.viewing_pubkey)?;

    // Generate ephemeral scalar and compute R = r * G
    let ephemeral_scalar = ScalarField::rand(&mut rng);
    let ephemeral_pubkey_proj: EdwardsProjective =
        EdwardsProjective::generator() * ephemeral_scalar;
    let ephemeral_pubkey = ephemeral_pubkey_proj.into_affine();

    // ECDH: shared_point = r * viewing_pubkey
    let shared_point_proj: EdwardsProjective =
        EdwardsProjective::from(viewing_pubkey) * ephemeral_scalar;
    let shared_point = shared_point_proj.into_affine();

    // shared_secret = Poseidon(shared_point.x, shared_point.y)
    let sp_bytes = point_to_bytes(&shared_point);
    let shared_secret = poseidon_hash(&sp_bytes[0], &sp_bytes[1])
        .map_err(|_| StealthError::DerivationFailed)?;

    // one_time_owner = Poseidon(spending_pubkey, shared_secret)
    let one_time_owner = poseidon_hash(&recipient_meta.spending_pubkey, &shared_secret)
        .map_err(|_| StealthError::DerivationFailed)?;

    Ok(StealthSendResult {
        one_time_owner,
        shared_secret,
        ephemeral_pubkey: point_to_bytes(&ephemeral_pubkey),
    })
}

/// Recipient: check if a note is addressed to us using BabyJubJub ECDH.
///
/// Computes shared_point = viewing_key * R (commutative with sender's r * viewing_pubkey),
/// derives the expected owner, and compares.
///
/// Returns Some(shared_secret) if the note belongs to us, None otherwise.
pub fn stealth_receive(
    viewing_key: &[u8; 32],
    spending_pubkey: &[u8; 32],
    ephemeral_pubkey: &[[u8; 32]; 2],
    note_owner: &[u8; 32],
) -> Result<Option<[u8; 32]>, StealthError> {
    // Parse ephemeral pubkey as a BabyJubJub point
    let eph_point = bytes_to_point(ephemeral_pubkey)?;

    // Recover viewing_key as a scalar
    let vk_scalar = ScalarField::from_be_bytes_mod_order(viewing_key);

    // ECDH: shared_point = viewing_key * R  (== r * viewing_pubkey by commutativity)
    let shared_point_proj: EdwardsProjective =
        EdwardsProjective::from(eph_point) * vk_scalar;
    let shared_point = shared_point_proj.into_affine();

    // shared_secret = Poseidon(shared_point.x, shared_point.y)
    let sp_bytes = point_to_bytes(&shared_point);
    let shared_secret = poseidon_hash(&sp_bytes[0], &sp_bytes[1])
        .map_err(|_| StealthError::DerivationFailed)?;

    // expected_owner = Poseidon(spending_pubkey, shared_secret)
    let expected_owner = poseidon_hash(spending_pubkey, &shared_secret)
        .map_err(|_| StealthError::DerivationFailed)?;

    // Constant-time comparison
    let mut diff = 0u8;
    for (a, b) in expected_owner.iter().zip(note_owner.iter()) {
        diff |= a ^ b;
    }

    if diff == 0 {
        Ok(Some(shared_secret))
    } else {
        Ok(None)
    }
}

/// Generate a BabyJubJub keypair for stealth meta-address.
///
/// Returns (secret_key_bytes, pubkey_point_bytes) where pubkey = secret * G.
pub fn generate_bjj_keypair() -> ([u8; 32], [[u8; 32]; 2]) {
    let mut rng = rand::thread_rng();
    let secret = ScalarField::rand(&mut rng);
    let pubkey = (EdwardsProjective::generator() * secret).into_affine();

    let secret_bigint: <ScalarField as PrimeField>::BigInt = secret.into();
    let secret_be = secret_bigint.to_bytes_be();
    let mut secret_bytes = [0u8; 32];
    secret_bytes[32 - secret_be.len()..].copy_from_slice(&secret_be);

    (secret_bytes, point_to_bytes(&pubkey))
}

/// Derive a BabyJubJub public key from a secret key scalar.
pub fn derive_bjj_pubkey(secret: &[u8; 32]) -> Result<[[u8; 32]; 2], StealthError> {
    let scalar = ScalarField::from_be_bytes_mod_order(secret);
    if scalar.is_zero() {
        return Err(StealthError::DerivationFailed);
    }
    let pubkey = (EdwardsProjective::generator() * scalar).into_affine();
    Ok(point_to_bytes(&pubkey))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stealth_address_roundtrip() {
        // Generate recipient keys
        let (viewing_key, viewing_pubkey) = generate_bjj_keypair();
        let spending_key = [20u8; 32];
        let spending_pubkey = holanc_primitives::poseidon::poseidon_hash(
            &spending_key, &[0u8; 32],
        ).unwrap();

        let meta = StealthMetaAddress {
            viewing_pubkey,
            spending_pubkey,
        };

        // Sender generates stealth address
        let send_result = stealth_send(&meta).unwrap();
        assert_ne!(send_result.one_time_owner, [0u8; 32]);
        assert_ne!(send_result.shared_secret, [0u8; 32]);

        // Recipient scans and finds the note
        let recv_result = stealth_receive(
            &viewing_key,
            &spending_pubkey,
            &send_result.ephemeral_pubkey,
            &send_result.one_time_owner,
        ).unwrap();
        assert!(recv_result.is_some(), "Recipient should find their note via ECDH");
        assert_eq!(recv_result.unwrap(), send_result.shared_secret);
    }

    #[test]
    fn test_stealth_receive_rejects_wrong_owner() {
        let (viewing_key, viewing_pubkey) = generate_bjj_keypair();
        let spending_pubkey = [20u8; 32];

        let meta = StealthMetaAddress {
            viewing_pubkey,
            spending_pubkey,
        };

        let send_result = stealth_send(&meta).unwrap();
        let wrong_owner = [99u8; 32];

        let result = stealth_receive(
            &viewing_key,
            &spending_pubkey,
            &send_result.ephemeral_pubkey,
            &wrong_owner,
        ).unwrap();
        assert!(result.is_none(), "Wrong owner should not match");
    }

    #[test]
    fn test_stealth_send_produces_unique_ephemeral_keys() {
        let (_, viewing_pubkey) = generate_bjj_keypair();
        let meta = StealthMetaAddress {
            viewing_pubkey,
            spending_pubkey: [20u8; 32],
        };
        let r1 = stealth_send(&meta).unwrap();
        let r2 = stealth_send(&meta).unwrap();
        assert_ne!(r1.ephemeral_pubkey, r2.ephemeral_pubkey);
        assert_ne!(r1.one_time_owner, r2.one_time_owner);
    }

    #[test]
    fn test_different_viewing_key_cannot_scan() {
        let (_, viewing_pubkey) = generate_bjj_keypair();
        let spending_pubkey = [20u8; 32];
        let meta = StealthMetaAddress {
            viewing_pubkey,
            spending_pubkey,
        };

        let send_result = stealth_send(&meta).unwrap();

        // A different viewing key should NOT find the note
        let (other_viewing_key, _) = generate_bjj_keypair();
        let result = stealth_receive(
            &other_viewing_key,
            &spending_pubkey,
            &send_result.ephemeral_pubkey,
            &send_result.one_time_owner,
        ).unwrap();
        assert!(result.is_none(), "Different viewing key must not match");
    }

    #[test]
    fn test_derive_bjj_pubkey() {
        let (secret, expected_pubkey) = generate_bjj_keypair();
        let derived = derive_bjj_pubkey(&secret).unwrap();
        assert_eq!(derived, expected_pubkey);
    }
}
