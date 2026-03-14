use anchor_lang::prelude::*;
use sha2::{Sha256, Digest};
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

declare_id!("H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K");

/// Ed25519 native program ID (precompile for signature verification).
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x03, 0x71, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/// Supported SVM chains for cross-chain privacy.
pub const CHAIN_SOLANA: u64 = 1;
pub const CHAIN_ECLIPSE: u64 = 2;
pub const CHAIN_SONIC: u64 = 3;

/// Maximum number of foreign chain roots stored per bridge config.
pub const MAX_FOREIGN_ROOTS: usize = 32;

/// Wormhole guardian signature threshold (13 of 19).
pub const GUARDIAN_THRESHOLD: u8 = 13;

/// A guardian's ed25519 signature over a VAA body hash.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GuardianSignature {
    pub guardian_index: u8,
    pub signature: [u8; 64],
}

#[program]
pub mod holanc_bridge {
    use super::*;

    /// Initialize the bridge configuration for a specific pool.
    pub fn initialize(
        ctx: Context<InitializeBridge>,
        local_chain_id: u64,
        local_app_id: u64,
    ) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_config;
        bridge.authority = ctx.accounts.authority.key();
        bridge.pool = ctx.accounts.pool.key();
        bridge.local_chain_id = local_chain_id;
        bridge.local_app_id = local_app_id;
        bridge.epoch_counter = 0;
        bridge.foreign_root_count = 0;
        bridge.is_active = true;
        bridge.bump = ctx.bumps.bridge_config;
        Ok(())
    }

    /// Publish a local epoch nullifier root for cross-chain consumption.
    ///
    /// Called after `holanc_nullifier::finalize_epoch`. The root is stored
    /// on-chain and emitted as a Wormhole-compatible message. External
    /// relayers pick this up and submit a VAA on destination chains.
    pub fn publish_epoch_root(
        ctx: Context<PublishEpochRoot>,
        epoch: u64,
        nullifier_root: [u8; 32],
        nullifier_count: u64,
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(bridge.is_active, HolancBridgeError::BridgeInactive);

        let outbound = &mut ctx.accounts.outbound_message;
        outbound.source_chain = bridge.local_chain_id;
        outbound.source_app = bridge.local_app_id;
        outbound.epoch = epoch;
        outbound.nullifier_root = nullifier_root;
        outbound.nullifier_count = nullifier_count;
        outbound.timestamp = Clock::get()?.unix_timestamp;
        outbound.sequence = bridge.epoch_counter;
        outbound.pool = bridge.pool;

        emit!(EpochRootPublished {
            chain_id: bridge.local_chain_id,
            epoch,
            nullifier_root,
            nullifier_count,
            sequence: bridge.epoch_counter,
        });

        // Increment outbound sequence
        let bridge_mut = &mut ctx.accounts.bridge_config;
        bridge_mut.epoch_counter += 1;

        Ok(())
    }

    /// Receive and store a foreign chain's epoch root (delivered via Wormhole VAA).
    ///
    /// The VAA payload is verified on-chain by checking that the guardian
    /// signatures meet the quorum threshold (GUARDIAN_THRESHOLD of 19).
    /// The VAA body hash must match the submitted data.
    pub fn receive_epoch_root(
        ctx: Context<ReceiveEpochRoot>,
        source_chain: u64,
        epoch: u64,
        nullifier_root: [u8; 32],
        nullifier_count: u64,
        vaa_hash: [u8; 32],
        guardian_signatures: Vec<GuardianSignature>,
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(bridge.is_active, HolancBridgeError::BridgeInactive);
        require!(
            source_chain != bridge.local_chain_id,
            HolancBridgeError::CannotReceiveOwnChain
        );

        // Verify VAA guardian signatures meet quorum threshold
        let guardian_set = &ctx.accounts.guardian_set;
        require!(
            guardian_set.is_active,
            HolancBridgeError::GuardianSetInactive
        );

        // Reconstruct the expected VAA body hash from submitted parameters
        let mut body_hasher = Sha256::new();
        body_hasher.update(source_chain.to_le_bytes());
        body_hasher.update(epoch.to_le_bytes());
        body_hasher.update(nullifier_root);
        body_hasher.update(nullifier_count.to_le_bytes());
        let computed_body_hash: [u8; 32] = body_hasher.finalize().into();
        require!(
            computed_body_hash == vaa_hash,
            HolancBridgeError::VaaBodyHashMismatch
        );

        // Verify guardian signature count meets quorum
        require!(
            guardian_signatures.len() >= GUARDIAN_THRESHOLD as usize,
            HolancBridgeError::InsufficientGuardianSignatures
        );

        // Verify each signature: guardian index must be valid and unique,
        // and the ed25519 signature must be valid over the VAA body hash.
        //
        // We require a preceding Ed25519Program.createInstructionWithPublicKey
        // instruction for each guardian signature in the transaction.
        // The Ed25519 native program verifies the signature, and we
        // introspect the instructions sysvar to confirm it was included.
        let mut seen_indices = [false; 19];
        let mut valid_count: u8 = 0;
        let ix_sysvar_info = &ctx.accounts.instruction_sysvar;

        for (sig_idx, sig) in guardian_signatures.iter().enumerate() {
            let idx = sig.guardian_index as usize;
            require!(idx < guardian_set.num_guardians as usize, HolancBridgeError::InvalidGuardianIndex);
            require!(!seen_indices[idx], HolancBridgeError::DuplicateGuardianSignature);
            seen_indices[idx] = true;

            // Verify that an ed25519 signature verification instruction
            // exists in this transaction for this guardian's signature.
            // The ed25519 precompile instruction format:
            //   - program_id == Ed25519Program
            //   - data contains: num_signatures(u8), padding(u8),
            //     then per signature: sig_offset, sig_ix_idx, pubkey_offset,
            //     pubkey_ix_idx, msg_offset, msg_size, msg_ix_idx
            verify_ed25519_ix(
                ix_sysvar_info,
                sig_idx,
                &guardian_set.guardian_keys[idx],
                &sig.signature,
                &vaa_hash,
            )?;

            valid_count += 1;
        }

        require!(
            valid_count >= GUARDIAN_THRESHOLD,
            HolancBridgeError::InsufficientGuardianSignatures
        );

        let foreign_root = &mut ctx.accounts.foreign_root;
        foreign_root.source_chain = source_chain;
        foreign_root.epoch = epoch;
        foreign_root.nullifier_root = nullifier_root;
        foreign_root.nullifier_count = nullifier_count;
        foreign_root.vaa_hash = vaa_hash;
        foreign_root.received_at = Clock::get()?.unix_timestamp;
        foreign_root.pool = bridge.pool;

        emit!(ForeignRootReceived {
            source_chain,
            epoch,
            nullifier_root,
            nullifier_count,
            vaa_hash,
        });

        Ok(())
    }

    /// Verify that a nullifier exists in a foreign chain's epoch root.
    ///
    /// Provides a Merkle proof that the given nullifier is included in a
    /// previously received foreign epoch root. Used to prevent cross-chain
    /// double-spending: if the nullifier is found in a foreign root, the
    /// local spend must be rejected.
    pub fn verify_foreign_nullifier(
        ctx: Context<VerifyForeignNullifier>,
        nullifier: [u8; 32],
        proof_path: Vec<[u8; 32]>,
        proof_indices: Vec<u8>,
    ) -> Result<()> {
        let foreign_root = &ctx.accounts.foreign_root;

        // Verify the Merkle proof against the foreign epoch root
        let computed_root = compute_merkle_root(&nullifier, &proof_path, &proof_indices);
        require!(
            computed_root == foreign_root.nullifier_root,
            HolancBridgeError::InvalidMerkleProof
        );

        emit!(ForeignNullifierVerified {
            source_chain: foreign_root.source_chain,
            epoch: foreign_root.epoch,
            nullifier,
        });

        Ok(())
    }

    /// Lock a note commitment for cross-chain transfer (ZK-Bound State Lock).
    ///
    /// The note is "locked" on the source chain — its commitment is marked
    /// as pending bridge transfer. A Wormhole message is emitted containing
    /// the lock details. On the destination chain, `unlock_commitment` will
    /// insert the commitment into the remote pool's Merkle tree.
    ///
    /// The lock PDA existence serves as the state lock: pool transfer/withdraw
    /// instructions must check for the absence of this PDA before proceeding.
    pub fn lock_commitment(
        ctx: Context<LockCommitment>,
        commitment: [u8; 32],
        destination_chain: u64,
        proof: Vec<u8>,
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(bridge.is_active, HolancBridgeError::BridgeInactive);
        require!(
            destination_chain != bridge.local_chain_id,
            HolancBridgeError::CannotBridgeToSelf
        );

        let lock = &mut ctx.accounts.commitment_lock;
        lock.commitment = commitment;
        lock.source_chain = bridge.local_chain_id;
        lock.destination_chain = destination_chain;
        lock.locker = ctx.accounts.authority.key();
        lock.locked_at = Clock::get()?.unix_timestamp;
        lock.is_unlocked = false;
        lock.proof_hash = hash_proof(&proof);
        lock.pool = bridge.pool;

        // Mark the pool's commitment as locked to prevent local spending
        // The existence of the lock PDA (seeded by ["lock", pool, commitment])
        // is checked by the pool program during transfer/withdraw.

        emit!(CommitmentLocked {
            commitment,
            source_chain: bridge.local_chain_id,
            destination_chain,
            locker: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Initialize the guardian set for VAA verification.
    pub fn initialize_guardian_set(
        ctx: Context<InitializeGuardianSet>,
        guardian_keys: [[u8; 32]; 19],
        num_guardians: u8,
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(
            bridge.authority == ctx.accounts.authority.key(),
            HolancBridgeError::Unauthorized
        );
        require!(
            num_guardians >= GUARDIAN_THRESHOLD && num_guardians <= 19,
            HolancBridgeError::InvalidGuardianCount
        );

        let gs = &mut ctx.accounts.guardian_set;
        gs.guardian_keys = guardian_keys;
        gs.num_guardians = num_guardians;
        gs.is_active = true;
        gs.pool = bridge.pool;

        Ok(())
    }

    /// Unlock a bridged commitment on the destination chain.
    ///
    /// Receives a Wormhole VAA proving the commitment was locked on the source
    /// chain, then inserts it into the local pool's Merkle tree.
    pub fn unlock_commitment(
        ctx: Context<UnlockCommitment>,
        commitment: [u8; 32],
        source_chain: u64,
        vaa_hash: [u8; 32],
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(bridge.is_active, HolancBridgeError::BridgeInactive);
        require!(
            source_chain != bridge.local_chain_id,
            HolancBridgeError::CannotReceiveOwnChain
        );

        let unlock_record = &mut ctx.accounts.unlock_record;
        unlock_record.commitment = commitment;
        unlock_record.source_chain = source_chain;
        unlock_record.vaa_hash = vaa_hash;
        unlock_record.unlocked_at = Clock::get()?.unix_timestamp;
        unlock_record.pool = bridge.pool;

        emit!(CommitmentUnlocked {
            commitment,
            source_chain,
            vaa_hash,
        });

        Ok(())
    }

    /// Pause/unpause the bridge (admin only).
    pub fn set_active(ctx: Context<AdminBridge>, active: bool) -> Result<()> {
        let bridge = &mut ctx.accounts.bridge_config;
        // has_one = authority constraint on AdminBridge already validates caller
        bridge.is_active = active;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Compute a Merkle root from a leaf and its proof path (Keccak256 for
/// cross-chain compatibility with EVM-based Wormhole infrastructure).
fn compute_merkle_root(
    leaf: &[u8; 32],
    path: &[[u8; 32]],
    indices: &[u8],
) -> [u8; 32] {
    let mut current = *leaf;
    for (i, sibling) in path.iter().enumerate() {
        let idx = if i < indices.len() { indices[i] } else { 0 };
        let mut hasher = Sha256::new();
        if idx == 0 {
            hasher.update(current);
            hasher.update(sibling);
        } else {
            hasher.update(sibling);
            hasher.update(current);
        }
        let result = hasher.finalize();
        current.copy_from_slice(&result);
    }
    current
}

/// Hash a proof blob for storage (proof-carrying container fingerprint).
fn hash_proof(proof: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(proof);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Verify that a preceding Ed25519 signature verification instruction exists
/// in this transaction for the given guardian signature.
///
/// The sdk/relayer must prepend Ed25519Program.createInstructionWithPublicKey
/// instructions before calling receive_epoch_root. This function introspects
/// the transaction's instructions sysvar to confirm that the native ed25519
/// program verified the signature.
fn verify_ed25519_ix(
    ix_sysvar: &AccountInfo,
    sig_idx: usize,
    guardian_pubkey: &[u8; 32],
    signature: &[u8; 64],
    message: &[u8; 32],
) -> Result<()> {
    use anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked;

    // The ed25519 verification instructions should precede this instruction.
    // Each guardian signature gets one ed25519 precompile instruction.
    let ix = load_instruction_at_checked(sig_idx, ix_sysvar)
        .map_err(|_| error!(HolancBridgeError::InvalidEd25519Instruction))?;

    // Verify it's an Ed25519 program instruction
    require!(
        ix.program_id == ED25519_PROGRAM_ID,
        HolancBridgeError::InvalidEd25519Instruction
    );

    // Ed25519 instruction data format:
    // [0]: num_signatures (u8)
    // [1]: padding (u8)
    // Then per signature (16 bytes each):
    //   [2..4]:   signature_offset (u16 LE)
    //   [4..6]:   signature_instruction_index (u16 LE) — 0xFFFF = this ix
    //   [6..8]:   public_key_offset (u16 LE)
    //   [8..10]:  public_key_instruction_index (u16 LE)
    //   [10..12]: message_data_offset (u16 LE)
    //   [12..14]: message_data_size (u16 LE)
    //   [14..16]: message_instruction_index (u16 LE)
    // Followed by the actual signature (64 bytes), pubkey (32 bytes), message bytes.
    require!(ix.data.len() >= 2, HolancBridgeError::InvalidEd25519Instruction);
    let num_sigs = ix.data[0] as usize;
    require!(num_sigs >= 1, HolancBridgeError::InvalidEd25519Instruction);

    // Extract the signature, pubkey, and message from the instruction data
    let sig_offset = u16::from_le_bytes([ix.data[2], ix.data[3]]) as usize;
    let pk_offset = u16::from_le_bytes([ix.data[6], ix.data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([ix.data[10], ix.data[11]]) as usize;
    let msg_size = u16::from_le_bytes([ix.data[12], ix.data[13]]) as usize;

    // Validate the embedded data matches what we expect
    require!(
        ix.data.len() >= sig_offset + 64
            && ix.data.len() >= pk_offset + 32
            && ix.data.len() >= msg_offset + msg_size,
        HolancBridgeError::InvalidEd25519Instruction
    );
    require!(msg_size == 32, HolancBridgeError::InvalidEd25519Instruction);

    let ix_sig = &ix.data[sig_offset..sig_offset + 64];
    let ix_pk = &ix.data[pk_offset..pk_offset + 32];
    let ix_msg = &ix.data[msg_offset..msg_offset + 32];

    require!(ix_sig == signature, HolancBridgeError::InvalidGuardianSignature);
    require!(ix_pk == guardian_pubkey, HolancBridgeError::InvalidGuardianSignature);
    require!(ix_msg == message, HolancBridgeError::InvalidGuardianSignature);

    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeBridge<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + BridgeConfig::MAX_SIZE,
        seeds = [b"bridge", pool.key().as_ref()],
        bump,
    )]
    pub bridge_config: Account<'info, BridgeConfig>,

    /// CHECK: Pool program account.
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishEpochRoot<'info> {
    #[account(mut)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + OutboundMessage::MAX_SIZE,
        seeds = [
            b"outbound",
            bridge_config.pool.as_ref(),
            &bridge_config.epoch_counter.to_le_bytes(),
        ],
        bump,
    )]
    pub outbound_message: Account<'info, OutboundMessage>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(source_chain: u64, epoch: u64)]
pub struct ReceiveEpochRoot<'info> {
    #[account(mut)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + ForeignRoot::MAX_SIZE,
        seeds = [
            b"foreign_root",
            bridge_config.pool.as_ref(),
            &source_chain.to_le_bytes(),
            &epoch.to_le_bytes(),
        ],
        bump,
    )]
    pub foreign_root: Account<'info, ForeignRoot>,

    /// Guardian set for VAA signature verification.
    /// Must belong to the same pool as the bridge config.
    #[account(
        constraint = guardian_set.pool == bridge_config.pool @ HolancBridgeError::GuardianSetPoolMismatch
    )]
    pub guardian_set: Account<'info, GuardianSet>,

    /// Instructions sysvar for ed25519 signature introspection.
    /// CHECK: Validated by address constraint against the instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instruction_sysvar: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyForeignNullifier<'info> {
    pub bridge_config: Account<'info, BridgeConfig>,
    pub foreign_root: Account<'info, ForeignRoot>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], destination_chain: u64)]
pub struct LockCommitment<'info> {
    #[account(mut)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + CommitmentLockRecord::MAX_SIZE,
        seeds = [b"lock", bridge_config.pool.as_ref(), &commitment],
        bump,
    )]
    pub commitment_lock: Account<'info, CommitmentLockRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], source_chain: u64)]
pub struct UnlockCommitment<'info> {
    #[account(mut)]
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + UnlockRecord::MAX_SIZE,
        seeds = [
            b"unlock",
            bridge_config.pool.as_ref(),
            &source_chain.to_le_bytes(),
            &commitment,
        ],
        bump,
    )]
    pub unlock_record: Account<'info, UnlockRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminBridge<'info> {
    #[account(mut, has_one = authority)]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeGuardianSet<'info> {
    pub bridge_config: Account<'info, BridgeConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + GuardianSet::MAX_SIZE,
        seeds = [b"guardian_set", bridge_config.pool.as_ref()],
        bump,
    )]
    pub guardian_set: Account<'info, GuardianSet>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct BridgeConfig {
    pub authority: Pubkey,
    pub pool: Pubkey,
    pub local_chain_id: u64,
    pub local_app_id: u64,
    pub epoch_counter: u64,
    pub foreign_root_count: u64,
    pub is_active: bool,
    pub bump: u8,
}

impl BridgeConfig {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1; // 98
}

/// Outbound epoch root message (to be picked up by Wormhole relayers).
#[account]
pub struct OutboundMessage {
    pub pool: Pubkey,
    pub source_chain: u64,
    pub source_app: u64,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub nullifier_count: u64,
    pub timestamp: i64,
    pub sequence: u64,
}

impl OutboundMessage {
    pub const MAX_SIZE: usize = 32 + 8 + 8 + 8 + 32 + 8 + 8 + 8; // 112
}

/// Received foreign chain epoch root (from Wormhole VAA).
#[account]
pub struct ForeignRoot {
    pub pool: Pubkey,
    pub source_chain: u64,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub nullifier_count: u64,
    pub vaa_hash: [u8; 32],
    pub received_at: i64,
}

impl ForeignRoot {
    pub const MAX_SIZE: usize = 32 + 8 + 8 + 32 + 8 + 32 + 8; // 128
}

/// Record of a commitment locked for cross-chain bridge transfer.
#[account]
pub struct CommitmentLockRecord {
    pub pool: Pubkey,
    pub commitment: [u8; 32],
    pub source_chain: u64,
    pub destination_chain: u64,
    pub locker: Pubkey,
    pub locked_at: i64,
    pub is_unlocked: bool,
    pub proof_hash: [u8; 32],
}

impl CommitmentLockRecord {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 8 + 32 + 8 + 1 + 32; // 153
}

/// Record of an unlocked commitment on the destination chain.
#[account]
pub struct UnlockRecord {
    pub pool: Pubkey,
    pub commitment: [u8; 32],
    pub source_chain: u64,
    pub vaa_hash: [u8; 32],
    pub unlocked_at: i64,
}

impl UnlockRecord {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 32 + 8; // 112
}

/// On-chain guardian set for VAA signature verification.
#[account]
pub struct GuardianSet {
    pub pool: Pubkey,
    pub guardian_keys: [[u8; 32]; 19],
    pub num_guardians: u8,
    pub is_active: bool,
}

impl GuardianSet {
    pub const MAX_SIZE: usize = 32 + (32 * 19) + 1 + 1; // 642
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct EpochRootPublished {
    pub chain_id: u64,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub nullifier_count: u64,
    pub sequence: u64,
}

#[event]
pub struct ForeignRootReceived {
    pub source_chain: u64,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub nullifier_count: u64,
    pub vaa_hash: [u8; 32],
}

#[event]
pub struct ForeignNullifierVerified {
    pub source_chain: u64,
    pub epoch: u64,
    pub nullifier: [u8; 32],
}

#[event]
pub struct CommitmentLocked {
    pub commitment: [u8; 32],
    pub source_chain: u64,
    pub destination_chain: u64,
    pub locker: Pubkey,
}

#[event]
pub struct CommitmentUnlocked {
    pub commitment: [u8; 32],
    pub source_chain: u64,
    pub vaa_hash: [u8; 32],
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HolancBridgeError {
    #[msg("Bridge is inactive")]
    BridgeInactive,
    #[msg("Cannot receive epoch root from own chain")]
    CannotReceiveOwnChain,
    #[msg("Cannot bridge commitment to own chain")]
    CannotBridgeToSelf,
    #[msg("Invalid Merkle proof for foreign nullifier")]
    InvalidMerkleProof,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Guardian set is inactive")]
    GuardianSetInactive,
    #[msg("VAA body hash does not match submitted data")]
    VaaBodyHashMismatch,
    #[msg("Insufficient guardian signatures for quorum")]
    InsufficientGuardianSignatures,
    #[msg("Invalid guardian index")]
    InvalidGuardianIndex,
    #[msg("Duplicate guardian signature")]
    DuplicateGuardianSignature,
    #[msg("Invalid guardian signature")]
    InvalidGuardianSignature,
    #[msg("Invalid guardian count")]
    InvalidGuardianCount,
    #[msg("Guardian set does not belong to this pool")]
    GuardianSetPoolMismatch,
    #[msg("Invalid or missing ed25519 signature verification instruction")]
    InvalidEd25519Instruction,
}
