use anchor_lang::prelude::*;

declare_id!("GmkUhTQ5LKxRFfwEhJTGYpsBE8Y7mMBpfqwe7mX71Gpi");

/// Maximum number of public inputs for a Groth16 proof (transfer circuit: 6).
pub const MAX_PUBLIC_INPUTS: usize = 8;

/// Serialised sizes (uncompressed BN254 points).
pub const G1_SIZE: usize = 64; // 2 × 32-byte coordinates
pub const G2_SIZE: usize = 128; // 2 × 2 × 32-byte coordinates

#[program]
pub mod holanc_verifier {
    use super::*;

    /// One-time initialization: store a Groth16 verification key for a circuit type.
    pub fn initialize_vk(
        ctx: Context<InitializeVk>,
        circuit_type: u8,
        vk_alpha_g1: [u8; G1_SIZE],
        vk_beta_g2: [u8; G2_SIZE],
        vk_gamma_g2: [u8; G2_SIZE],
        vk_delta_g2: [u8; G2_SIZE],
        ic: Vec<[u8; G1_SIZE]>,
    ) -> Result<()> {
        require!(ic.len() <= MAX_PUBLIC_INPUTS + 1, HolancVerifierError::TooManyIcPoints);

        let vk_account = &mut ctx.accounts.verification_key;
        vk_account.authority = ctx.accounts.authority.key();
        vk_account.circuit_type = circuit_type;
        vk_account.alpha_g1 = vk_alpha_g1;
        vk_account.beta_g2 = vk_beta_g2;
        vk_account.gamma_g2 = vk_gamma_g2;
        vk_account.delta_g2 = vk_delta_g2;
        vk_account.ic_len = ic.len() as u8;
        for (i, point) in ic.iter().enumerate() {
            vk_account.ic[i] = *point;
        }
        vk_account.bump = ctx.bumps.verification_key;
        Ok(())
    }

    /// Verify a Groth16 proof on-chain using Solana's alt_bn128 syscalls.
    ///
    /// Proof elements:
    ///   - proof_a: G1 point (π_A)
    ///   - proof_b: G2 point (π_B)
    ///   - proof_c: G1 point (π_C)
    ///   - public_inputs: field elements (32 bytes each, big-endian)
    ///
    /// Verification equation (pairing check):
    ///   e(π_A, π_B) == e(α, β) · e(vk_x, γ) · e(π_C, δ)
    ///
    /// Where vk_x = IC[0] + Σ(public_input[i] · IC[i+1])
    pub fn verify_proof(
        ctx: Context<VerifyProof>,
        proof_a: [u8; G1_SIZE],
        proof_b: [u8; G2_SIZE],
        proof_c: [u8; G1_SIZE],
        public_inputs: Vec<[u8; 32]>,
    ) -> Result<()> {
        let vk = &ctx.accounts.verification_key;

        let num_ic = vk.ic_len as usize;
        require!(
            public_inputs.len() + 1 == num_ic,
            HolancVerifierError::PublicInputCountMismatch
        );

        // Step 1: Compute vk_x = IC[0] + Σ(public_input[i] · IC[i+1])
        let mut vk_x = vk.ic[0];

        for (i, input) in public_inputs.iter().enumerate() {
            // scalar_mul: IC[i+1] * public_input[i]
            let mul_input = build_scalar_mul_input(&vk.ic[i + 1], input);
            let mul_result = alt_bn128_multiplication(&mul_input)
                .map_err(|_| HolancVerifierError::Bn128MulFailed)?;

            // point_add: vk_x += mul_result
            let add_input = build_point_add_input(&vk_x, &mul_result);
            let add_result = alt_bn128_addition(&add_input)
                .map_err(|_| HolancVerifierError::Bn128AddFailed)?;

            vk_x.copy_from_slice(&add_result[..G1_SIZE]);
        }

        // Step 2: Build pairing input for:
        //   e(-π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) == 1
        // Which is equivalent to checking the product of pairings equals identity.
        let neg_proof_a = negate_g1(&proof_a)?;
        let pairing_input = build_pairing_input(
            &neg_proof_a,
            &proof_b,
            &vk.alpha_g1,
            &vk.beta_g2,
            &vk_x,
            &vk.gamma_g2,
            &proof_c,
            &vk.delta_g2,
        );

        let pairing_result = alt_bn128_pairing(&pairing_input)
            .map_err(|_| HolancVerifierError::Bn128PairingFailed)?;

        // Pairing returns 1 (as 32-byte big-endian) if the check passes
        let mut expected = [0u8; 32];
        expected[31] = 1;
        require!(
            pairing_result == expected,
            HolancVerifierError::ProofVerificationFailed
        );

        // Emit verification event
        emit!(ProofVerified {
            circuit_type: vk.circuit_type,
            verifier: ctx.accounts.authority.key(),
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// alt_bn128 syscall wrappers
//
// Solana 2.x exposes a single `sol_alt_bn128_group_op` syscall with an
// operation code: 0 = addition, 1 = multiplication, 2 = pairing.
// ---------------------------------------------------------------------------

const ALT_BN128_ADD: u64 = 0;
const ALT_BN128_MUL: u64 = 1;
const ALT_BN128_PAIRING: u64 = 2;

/// Internal wrapper around the raw syscall.
fn alt_bn128_group_op(op: u64, input: &[u8], output: &mut [u8]) -> std::result::Result<(), ()> {
    #[cfg(target_os = "solana")]
    {
        #[allow(deprecated)]
        let result = unsafe {
            solana_program::syscalls::sol_alt_bn128_group_op(
                op,
                input.as_ptr(),
                input.len() as u64,
                output.as_mut_ptr(),
            )
        };
        if result == 0 { Ok(()) } else { Err(()) }
    }
    #[cfg(not(target_os = "solana"))]
    {
        let _ = (op, input, output);
        Err(())
    }
}

/// Calls the alt_bn128 addition precompile (G1 + G1 → G1).
fn alt_bn128_addition(input: &[u8]) -> std::result::Result<[u8; G1_SIZE], ()> {
    let mut out = [0u8; G1_SIZE];
    alt_bn128_group_op(ALT_BN128_ADD, input, &mut out)?;
    Ok(out)
}

/// Calls the alt_bn128 scalar multiplication precompile (scalar · G1 → G1).
fn alt_bn128_multiplication(input: &[u8]) -> std::result::Result<[u8; G1_SIZE], ()> {
    let mut out = [0u8; G1_SIZE];
    alt_bn128_group_op(ALT_BN128_MUL, input, &mut out)?;
    Ok(out)
}

/// Calls the alt_bn128 pairing precompile.
fn alt_bn128_pairing(input: &[u8]) -> std::result::Result<[u8; 32], ()> {
    let mut out = [0u8; 32];
    alt_bn128_group_op(ALT_BN128_PAIRING, input, &mut out)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/// Build input for scalar multiplication: [G1 point (64 bytes) | scalar (32 bytes)]
fn build_scalar_mul_input(point: &[u8; G1_SIZE], scalar: &[u8; 32]) -> [u8; G1_SIZE + 32] {
    let mut input = [0u8; G1_SIZE + 32];
    input[..G1_SIZE].copy_from_slice(point);
    input[G1_SIZE..].copy_from_slice(scalar);
    input
}

/// Build input for point addition: [G1 point A (64 bytes) | G1 point B (64 bytes)]
fn build_point_add_input(a: &[u8; G1_SIZE], b: &[u8; G1_SIZE]) -> [u8; G1_SIZE * 2] {
    let mut input = [0u8; G1_SIZE * 2];
    input[..G1_SIZE].copy_from_slice(a);
    input[G1_SIZE..].copy_from_slice(b);
    input
}

/// Build pairing check input: 4 pairs of (G1, G2) points.
fn build_pairing_input(
    a1: &[u8; G1_SIZE],
    b1: &[u8; G2_SIZE],
    a2: &[u8; G1_SIZE],
    b2: &[u8; G2_SIZE],
    a3: &[u8; G1_SIZE],
    b3: &[u8; G2_SIZE],
    a4: &[u8; G1_SIZE],
    b4: &[u8; G2_SIZE],
) -> Vec<u8> {
    let pair_size = G1_SIZE + G2_SIZE; // 192
    let mut input = vec![0u8; pair_size * 4];
    let mut offset = 0;
    for (g1, g2) in [(a1, b1), (a2, b2), (a3, b3), (a4, b4)] {
        input[offset..offset + G1_SIZE].copy_from_slice(g1);
        input[offset + G1_SIZE..offset + pair_size].copy_from_slice(g2);
        offset += pair_size;
    }
    input
}

/// Negate a G1 point (negate the y-coordinate modulo BN254 base field prime).
fn negate_g1(point: &[u8; G1_SIZE]) -> Result<[u8; G1_SIZE]> {
    // BN254 base field prime q
    let q: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
        0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
    ];

    let mut result = [0u8; G1_SIZE];
    // x coordinate stays the same
    result[..32].copy_from_slice(&point[..32]);

    // y' = q - y (mod q). If y is 0, y' is 0.
    let y = &point[32..64];
    let is_zero = y.iter().all(|&b| b == 0);
    if is_zero {
        result[32..64].copy_from_slice(y);
    } else {
        // Subtract: q - y using big-endian arithmetic
        let mut borrow: u16 = 0;
        for i in (0..32).rev() {
            let diff = (q[i] as u16) + 256 - (y[i] as u16) - borrow;
            result[32 + i] = (diff & 0xFF) as u8;
            borrow = if diff < 256 { 1 } else { 0 };
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(circuit_type: u8)]
pub struct InitializeVk<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VerificationKey::MAX_SIZE,
        seeds = [b"vk", &[circuit_type][..]],
        bump,
    )]
    pub verification_key: Account<'info, VerificationKey>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyProof<'info> {
    #[account()]
    pub verification_key: Account<'info, VerificationKey>,

    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct VerificationKey {
    pub authority: Pubkey,
    pub circuit_type: u8,
    pub bump: u8,
    pub alpha_g1: [u8; G1_SIZE],
    pub beta_g2: [u8; G2_SIZE],
    pub gamma_g2: [u8; G2_SIZE],
    pub delta_g2: [u8; G2_SIZE],
    pub ic_len: u8,
    /// IC points (max MAX_PUBLIC_INPUTS + 1 = 9).
    pub ic: [[u8; G1_SIZE]; MAX_PUBLIC_INPUTS + 1],
}

impl VerificationKey {
    pub const MAX_SIZE: usize =
        32          // authority
        + 1         // circuit_type
        + 1         // bump
        + G1_SIZE   // alpha_g1
        + G2_SIZE   // beta_g2
        + G2_SIZE   // gamma_g2
        + G2_SIZE   // delta_g2
        + 1         // ic_len
        + G1_SIZE * (MAX_PUBLIC_INPUTS + 1); // ic array
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ProofVerified {
    pub circuit_type: u8,
    pub verifier: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HolancVerifierError {
    #[msg("Too many IC points")]
    TooManyIcPoints,
    #[msg("Public input count does not match verification key")]
    PublicInputCountMismatch,
    #[msg("BN128 scalar multiplication failed")]
    Bn128MulFailed,
    #[msg("BN128 point addition failed")]
    Bn128AddFailed,
    #[msg("BN128 pairing check failed")]
    Bn128PairingFailed,
    #[msg("Proof verification failed")]
    ProofVerificationFailed,
}
