use anchor_lang::prelude::*;

declare_id!("8QKUprH8TMiffMga7tVJZ6qtvwZogmz9SibDswCWKnHE");

/// Verifier program ID for CPI (same as holanc-pool uses).
const VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xea, 0x56, 0x05, 0x0b, 0xab, 0xf1, 0x5f, 0x69,
    0xdd, 0xa7, 0x3b, 0x04, 0xa0, 0x8c, 0xd3, 0xa0,
    0x53, 0x52, 0x09, 0xa1, 0xd4, 0x11, 0x22, 0x75,
    0x13, 0x20, 0x07, 0xab, 0x3d, 0x64, 0x9a, 0x0b,
]);

/// Maximum number of compliance oracles that can be registered.
pub const MAX_ORACLES: usize = 16;

#[program]
pub mod holanc_compliance {
    use super::*;

    /// Initialize the compliance configuration for a pool.
    pub fn initialize(
        ctx: Context<InitializeCompliance>,
        compliance_mode: ComplianceMode,
    ) -> Result<()> {
        let config = &mut ctx.accounts.compliance_config;
        config.authority = ctx.accounts.authority.key();
        config.pool = ctx.accounts.pool.key();
        config.mode = compliance_mode;
        config.oracle_count = 0;
        config.total_disclosures = 0;
        config.is_active = true;
        config.bump = ctx.bumps.compliance_config;
        Ok(())
    }

    /// Register a compliance oracle (auditor/regulator) that can receive
    /// viewing key disclosures.
    pub fn register_oracle(
        ctx: Context<RegisterOracle>,
        oracle_pubkey: Pubkey,
        oracle_name: [u8; 32],
        permissions: OraclePermissions,
    ) -> Result<()> {
        let config = &mut ctx.accounts.compliance_config;
        require!(
            config.authority == ctx.accounts.authority.key(),
            HolancComplianceError::Unauthorized
        );
        require!(
            (config.oracle_count as usize) < MAX_ORACLES,
            HolancComplianceError::TooManyOracles
        );

        let oracle_record = &mut ctx.accounts.oracle_record;
        oracle_record.pool = config.pool;
        oracle_record.oracle_pubkey = oracle_pubkey;
        oracle_record.oracle_name = oracle_name;
        oracle_record.permissions = permissions;
        oracle_record.registered_at = Clock::get()?.unix_timestamp;
        oracle_record.is_active = true;
        oracle_record.disclosure_count = 0;

        config.oracle_count += 1;

        emit!(OracleRegistered {
            pool: config.pool,
            oracle: oracle_pubkey,
            permissions,
        });

        Ok(())
    }

    /// Disclose a viewing key to a registered oracle.
    ///
    /// The viewing key is encrypted with the oracle's public key before
    /// submission. This enables selective transparency — the oracle can
    /// decrypt and observe the user's transaction history without gaining
    /// spending authority.
    pub fn disclose_viewing_key(
        ctx: Context<DiscloseViewingKey>,
        encrypted_viewing_key: Vec<u8>,
        disclosure_scope: DisclosureScope,
    ) -> Result<()> {
        let oracle = &ctx.accounts.oracle_record;
        require!(oracle.is_active, HolancComplianceError::OracleInactive);

        // Enforce oracle permission: must have can_view to receive disclosures
        require!(
            oracle.permissions.can_view,
            HolancComplianceError::OracleLacksPermission
        );

        let disclosure = &mut ctx.accounts.disclosure_record;
        disclosure.pool = oracle.pool;
        disclosure.discloser = ctx.accounts.discloser.key();
        disclosure.oracle = oracle.oracle_pubkey;
        disclosure.encrypted_viewing_key = encrypted_viewing_key;
        disclosure.scope = disclosure_scope;
        disclosure.disclosed_at = Clock::get()?.unix_timestamp;
        disclosure.is_revoked = false;

        let config = &mut ctx.accounts.compliance_config;
        config.total_disclosures += 1;

        emit!(ViewingKeyDisclosed {
            pool: oracle.pool,
            discloser: ctx.accounts.discloser.key(),
            oracle: oracle.oracle_pubkey,
            scope: disclosure_scope,
        });

        Ok(())
    }

    /// Revoke a previous viewing key disclosure.
    ///
    /// After revocation, the oracle should delete its copy of the viewing key.
    /// Note: This is a cooperative revocation — the oracle may have already
    /// observed historical transactions. Forward secrecy is not guaranteed.
    pub fn revoke_disclosure(ctx: Context<RevokeDisclosure>) -> Result<()> {
        let disclosure = &mut ctx.accounts.disclosure_record;
        require!(
            disclosure.discloser == ctx.accounts.discloser.key(),
            HolancComplianceError::NotDiscloser
        );
        require!(
            !disclosure.is_revoked,
            HolancComplianceError::AlreadyRevoked
        );

        disclosure.is_revoked = true;
        disclosure.revoked_at = Some(Clock::get()?.unix_timestamp);

        emit!(DisclosureRevoked {
            pool: disclosure.pool,
            discloser: disclosure.discloser,
            oracle: disclosure.oracle,
        });

        Ok(())
    }

    /// Submit a ZK wealth proof attestation.
    ///
    /// Proves "my shielded balance is at least `threshold`" without revealing
    /// the exact amount. The proof is generated off-chain using the wealth
    /// proof circuit and **verified on-chain** via CPI to holanc-verifier.
    pub fn submit_wealth_proof(
        ctx: Context<SubmitWealthProof>,
        threshold: u64,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: Vec<[u8; 32]>,
        circuit_type: u8,
    ) -> Result<()> {
        // Enforce compliance mode: wealth proofs only in disclosure modes
        let config = &ctx.accounts.compliance_config;
        require!(
            config.mode != ComplianceMode::Permissionless,
            HolancComplianceError::ComplianceModeDisallows
        );

        // Verify the ZK proof via CPI to holanc-verifier before accepting.
        verify_proof_cpi(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verification_key,
            &ctx.accounts.prover,
            proof_a,
            proof_b,
            proof_c,
            public_inputs.clone(),
        )?;

        // The first public input must encode the threshold for binding.
        if let Some(first_input) = public_inputs.first() {
            let mut threshold_bytes = [0u8; 32];
            threshold_bytes[24..].copy_from_slice(&threshold.to_be_bytes());
            require!(
                *first_input == threshold_bytes,
                HolancComplianceError::ThresholdMismatch
            );
        }

        let attestation = &mut ctx.accounts.wealth_attestation;
        attestation.pool = ctx.accounts.compliance_config.pool;
        attestation.prover = ctx.accounts.prover.key();
        attestation.threshold = threshold;
        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        sha2::Digest::update(&mut hasher, &proof_a);
        sha2::Digest::update(&mut hasher, &proof_b);
        sha2::Digest::update(&mut hasher, &proof_c);
        let hash_result = sha2::Digest::finalize(hasher);
        attestation.proof_hash.copy_from_slice(&hash_result);
        attestation.circuit_type = circuit_type;
        attestation.attested_at = Clock::get()?.unix_timestamp;
        attestation.is_valid = true;
        attestation.expiry = Clock::get()?.unix_timestamp + 86_400; // 24h validity

        emit!(WealthProofSubmitted {
            pool: attestation.pool,
            prover: ctx.accounts.prover.key(),
            threshold,
            circuit_type,
        });

        Ok(())
    }

    /// Invalidate an expired or contested wealth proof.
    pub fn invalidate_wealth_proof(ctx: Context<InvalidateWealthProof>) -> Result<()> {
        let attestation = &mut ctx.accounts.wealth_attestation;
        let now = Clock::get()?.unix_timestamp;

        // Auto-invalidate expired proofs
        let is_expired = now > attestation.expiry;

        // Can be invalidated by the prover, by authority, or auto if expired
        let is_prover = attestation.prover == ctx.accounts.authority.key();
        let is_admin = ctx.accounts.compliance_config.authority == ctx.accounts.authority.key();

        require!(
            is_prover || is_expired || is_admin,
            HolancComplianceError::Unauthorized
        );

        attestation.is_valid = false;

        emit!(WealthProofInvalidated {
            pool: attestation.pool,
            prover: attestation.prover,
        });

        Ok(())
    }

    /// Query-time validation: check if a wealth attestation is still valid.
    /// Rejects expired proofs even if is_valid flag hasn't been flipped yet.
    pub fn validate_wealth_proof(ctx: Context<ValidateWealthProof>) -> Result<()> {
        let attestation = &ctx.accounts.wealth_attestation;
        let now = Clock::get()?.unix_timestamp;

        require!(attestation.is_valid, HolancComplianceError::ProofInvalidated);
        require!(
            now <= attestation.expiry,
            HolancComplianceError::ProofExpired
        );

        emit!(WealthProofValidated {
            pool: attestation.pool,
            prover: attestation.prover,
            threshold: attestation.threshold,
        });

        Ok(())
    }

    /// Deactivate an oracle (admin only).
    pub fn deactivate_oracle(ctx: Context<DeactivateOracle>) -> Result<()> {
        let config = &ctx.accounts.compliance_config;
        require!(
            config.authority == ctx.accounts.authority.key(),
            HolancComplianceError::Unauthorized
        );

        let oracle = &mut ctx.accounts.oracle_record;
        oracle.is_active = false;

        emit!(OracleDeactivated {
            pool: config.pool,
            oracle: oracle.oracle_pubkey,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Compliance mode determines how the pool interacts with regulatory hooks.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ComplianceMode {
    /// No compliance hooks — fully private.
    Permissionless,
    /// Optional disclosure — users can choose to share viewing keys.
    OptionalDisclosure,
    /// Mandatory disclosure — deposits require a registered oracle attestation.
    MandatoryDisclosure,
}

/// Permissions granted to a compliance oracle.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub struct OraclePermissions {
    /// Can receive viewing key disclosures.
    pub can_view: bool,
    /// Can request wealth proof attestations.
    pub can_request_wealth_proof: bool,
    /// Can flag transactions for review.
    pub can_flag: bool,
}

/// Scope of a viewing key disclosure.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DisclosureScope {
    /// Full history — oracle can see all past and future transactions.
    Full,
    /// Time-bounded — oracle can see transactions within a specific range.
    TimeBounded { start: i64, end: i64 },
    /// Amount-bounded — oracle can see transactions above a threshold.
    AmountBounded { min_amount: u64 },
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeCompliance<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ComplianceConfig::MAX_SIZE,
        seeds = [b"compliance", pool.key().as_ref()],
        bump,
    )]
    pub compliance_config: Account<'info, ComplianceConfig>,

    /// CHECK: Pool program account.
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(oracle_pubkey: Pubkey)]
pub struct RegisterOracle<'info> {
    #[account(mut)]
    pub compliance_config: Account<'info, ComplianceConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + OracleRecord::MAX_SIZE,
        seeds = [b"oracle", compliance_config.pool.as_ref(), oracle_pubkey.as_ref()],
        bump,
    )]
    pub oracle_record: Account<'info, OracleRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DiscloseViewingKey<'info> {
    #[account(mut)]
    pub compliance_config: Account<'info, ComplianceConfig>,

    pub oracle_record: Account<'info, OracleRecord>,

    #[account(
        init,
        payer = discloser,
        space = 8 + DisclosureRecord::MAX_SIZE,
        seeds = [
            b"disclosure",
            compliance_config.pool.as_ref(),
            discloser.key().as_ref(),
            oracle_record.oracle_pubkey.as_ref(),
        ],
        bump,
    )]
    pub disclosure_record: Account<'info, DisclosureRecord>,

    #[account(mut)]
    pub discloser: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeDisclosure<'info> {
    #[account(mut)]
    pub disclosure_record: Account<'info, DisclosureRecord>,

    pub discloser: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitWealthProof<'info> {
    pub compliance_config: Account<'info, ComplianceConfig>,

    #[account(
        init,
        payer = prover,
        space = 8 + WealthAttestation::MAX_SIZE,
        seeds = [
            b"wealth",
            compliance_config.pool.as_ref(),
            prover.key().as_ref(),
        ],
        bump,
    )]
    pub wealth_attestation: Account<'info, WealthAttestation>,

    /// The holanc-verifier program for proof CPI.
    /// CHECK: Verified by address constraint.
    #[account(address = VERIFIER_PROGRAM_ID)]
    pub verifier_program: AccountInfo<'info>,

    /// The verification key account for the wealth proof circuit.
    /// CHECK: Owned by the verifier program.
    pub verification_key: AccountInfo<'info>,

    #[account(mut)]
    pub prover: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InvalidateWealthProof<'info> {
    pub compliance_config: Account<'info, ComplianceConfig>,

    #[account(mut)]
    pub wealth_attestation: Account<'info, WealthAttestation>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeactivateOracle<'info> {
    pub compliance_config: Account<'info, ComplianceConfig>,

    #[account(mut)]
    pub oracle_record: Account<'info, OracleRecord>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ValidateWealthProof<'info> {
    pub wealth_attestation: Account<'info, WealthAttestation>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct ComplianceConfig {
    pub authority: Pubkey,
    pub pool: Pubkey,
    pub mode: ComplianceMode,
    pub oracle_count: u8,
    pub total_disclosures: u64,
    pub is_active: bool,
    pub bump: u8,
}

impl ComplianceConfig {
    pub const MAX_SIZE: usize = 32 + 32 + 1 + 1 + 8 + 1 + 1; // 76
}

#[account]
pub struct OracleRecord {
    pub pool: Pubkey,
    pub oracle_pubkey: Pubkey,
    pub oracle_name: [u8; 32],
    pub permissions: OraclePermissions,
    pub registered_at: i64,
    pub is_active: bool,
    pub disclosure_count: u64,
}

impl OracleRecord {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 3 + 8 + 1 + 8; // 116
}

#[account]
pub struct DisclosureRecord {
    pub pool: Pubkey,
    pub discloser: Pubkey,
    pub oracle: Pubkey,
    pub encrypted_viewing_key: Vec<u8>,
    pub scope: DisclosureScope,
    pub disclosed_at: i64,
    pub is_revoked: bool,
    pub revoked_at: Option<i64>,
}

impl DisclosureRecord {
    // Vec<u8> max ~256 bytes encrypted key, DisclosureScope max ~17, Option<i64> = 9
    pub const MAX_SIZE: usize = 32 + 32 + 32 + (4 + 256) + 17 + 8 + 1 + 9; // 391
}

#[account]
pub struct WealthAttestation {
    pub pool: Pubkey,
    pub prover: Pubkey,
    pub threshold: u64,
    pub proof_hash: [u8; 32],
    pub circuit_type: u8,
    pub attested_at: i64,
    pub is_valid: bool,
    pub expiry: i64,
}

impl WealthAttestation {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 32 + 1 + 8 + 1 + 8; // 122
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct OracleRegistered {
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub permissions: OraclePermissions,
}

#[event]
pub struct ViewingKeyDisclosed {
    pub pool: Pubkey,
    pub discloser: Pubkey,
    pub oracle: Pubkey,
    pub scope: DisclosureScope,
}

#[event]
pub struct DisclosureRevoked {
    pub pool: Pubkey,
    pub discloser: Pubkey,
    pub oracle: Pubkey,
}

#[event]
pub struct WealthProofSubmitted {
    pub pool: Pubkey,
    pub prover: Pubkey,
    pub threshold: u64,
    pub circuit_type: u8,
}

#[event]
pub struct WealthProofInvalidated {
    pub pool: Pubkey,
    pub prover: Pubkey,
}

#[event]
pub struct WealthProofValidated {
    pub pool: Pubkey,
    pub prover: Pubkey,
    pub threshold: u64,
}

#[event]
pub struct OracleDeactivated {
    pub pool: Pubkey,
    pub oracle: Pubkey,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// CPI to holanc-verifier's verify_proof instruction.
fn verify_proof_cpi<'info>(
    verifier_program: &AccountInfo<'info>,
    verification_key: &AccountInfo<'info>,
    prover: &Signer<'info>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: Vec<[u8; 32]>,
) -> Result<()> {
    use anchor_lang::solana_program::instruction::Instruction;
    use anchor_lang::solana_program::program::invoke;

    // Anchor discriminator for "verify_proof" = first 8 bytes of SHA256("global:verify_proof")
    let discriminator: [u8; 8] = [0xd9, 0xd3, 0xbf, 0x6e, 0x90, 0x0d, 0xba, 0x62];

    let mut data = Vec::with_capacity(8 + 64 + 128 + 64 + 4 + public_inputs.len() * 32);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&proof_a);
    data.extend_from_slice(&proof_b);
    data.extend_from_slice(&proof_c);
    data.extend_from_slice(&(public_inputs.len() as u32).to_le_bytes());
    for input in &public_inputs {
        data.extend_from_slice(input);
    }

    let ix = Instruction {
        program_id: *verifier_program.key,
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                *verification_key.key,
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                *prover.key,
                true,
            ),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            verification_key.clone(),
            prover.to_account_info(),
            verifier_program.clone(),
        ],
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HolancComplianceError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Too many oracles registered")]
    TooManyOracles,
    #[msg("Oracle is inactive")]
    OracleInactive,
    #[msg("Only the original discloser can revoke")]
    NotDiscloser,
    #[msg("Disclosure already revoked")]
    AlreadyRevoked,
    #[msg("Wealth proof ZK verification failed")]
    ProofVerificationFailed,
    #[msg("Threshold in public inputs does not match declared threshold")]
    ThresholdMismatch,
    #[msg("Oracle does not have the required permission")]
    OracleLacksPermission,
    #[msg("Compliance mode does not allow this operation")]
    ComplianceModeDisallows,
    #[msg("Wealth proof has been invalidated")]
    ProofInvalidated,
    #[msg("Wealth proof has expired")]
    ProofExpired,
}
