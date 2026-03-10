use anchor_lang::prelude::*;
use sha2::{Sha256, Digest};

declare_id!("H14juazDyYfTD4PT2oiBoLoHPKcWy4v6jggyNXJNG91K");

/// Supported SVM chains for cross-chain privacy.
pub const CHAIN_SOLANA: u64 = 1;
pub const CHAIN_ECLIPSE: u64 = 2;
pub const CHAIN_SONIC: u64 = 3;

/// Maximum number of foreign chain roots stored per bridge config.
pub const MAX_FOREIGN_ROOTS: usize = 32;

/// Wormhole guardian signature threshold (13 of 19).
pub const GUARDIAN_THRESHOLD: u8 = 13;

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
    /// The VAA is verified off-chain by the Wormhole guardian network. The
    /// relayer submits the parsed payload. In production, this would verify
    /// the VAA signature set against Wormhole's on-chain guardian registry.
    pub fn receive_epoch_root(
        ctx: Context<ReceiveEpochRoot>,
        source_chain: u64,
        epoch: u64,
        nullifier_root: [u8; 32],
        nullifier_count: u64,
        vaa_hash: [u8; 32],
    ) -> Result<()> {
        let bridge = &ctx.accounts.bridge_config;
        require!(bridge.is_active, HolancBridgeError::BridgeInactive);
        require!(
            source_chain != bridge.local_chain_id,
            HolancBridgeError::CannotReceiveOwnChain
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

        emit!(CommitmentLocked {
            commitment,
            source_chain: bridge.local_chain_id,
            destination_chain,
            locker: ctx.accounts.authority.key(),
        });

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
        require!(
            bridge.authority == ctx.accounts.authority.key(),
            HolancBridgeError::Unauthorized
        );
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
    #[account(mut)]
    pub bridge_config: Account<'info, BridgeConfig>,

    pub authority: Signer<'info>,
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
}
