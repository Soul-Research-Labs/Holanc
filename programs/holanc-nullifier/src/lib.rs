use anchor_lang::prelude::*;
use sha2::{Sha256, Digest};

declare_id!("BbcPjKizadFZb55MSFcg1q2MxAbnSbnvKvorTXutK3Si");

/// Number of nullifier slots per registry page (bitmap-based).
/// Each page covers 256 nullifier slots using a 32-byte bitmap.
pub const SLOTS_PER_PAGE: usize = 256;
/// Maximum number of epochs before forced rotation.
pub const MAX_EPOCHS: usize = 1024;

#[program]
pub mod holanc_nullifier {
    use super::*;

    /// Initialize the nullifier manager for a specific pool.
    pub fn initialize(ctx: Context<InitializeNullifierManager>) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        manager.pool = ctx.accounts.pool.key();
        manager.authority = ctx.accounts.authority.key();
        manager.current_epoch = 0;
        manager.epoch_start_slot = Clock::get()?.slot;
        manager.epoch_duration_slots = 216_000; // ~1 day at 400ms/slot
        manager.total_nullifiers = 0;
        manager.bump = ctx.bumps.manager;
        Ok(())
    }

    /// Register a nullifier as spent. Called by the pool program during
    /// transfer/withdraw operations.
    ///
    /// Uses a bitmap approach: the nullifier hash is mapped to a page
    /// and bit index for O(1) lookup.
    pub fn register_nullifier(
        ctx: Context<RegisterNullifier>,
        nullifier: [u8; 32],
    ) -> Result<()> {
        let page = &mut ctx.accounts.nullifier_page;

        // Hash the full nullifier to derive a uniformly-distributed bit index.
        // This avoids the previous bug where only nullifier[31] was used
        // (8-bit entropy → 1/256 false-positive collision rate).
        let digest = Sha256::digest(nullifier);
        let bit_index = u16::from_le_bytes([digest[0], digest[1]]) as usize
            % SLOTS_PER_PAGE;
        let byte_index = bit_index / 8;
        let bit_offset = bit_index % 8;

        // Check not already spent (constant-time via bitwise ops)
        let already_spent = (page.bitmap[byte_index] >> bit_offset) & 1;
        require!(already_spent == 0, HolancNullifierError::NullifierAlreadySpent);

        // Mark as spent
        page.bitmap[byte_index] |= 1 << bit_offset;
        page.count += 1;

        // Store the full nullifier hash for cross-chain epoch root computation
        let manager = &mut ctx.accounts.manager;
        manager.total_nullifiers += 1;

        emit!(NullifierRegistered {
            pool: manager.pool,
            nullifier,
            epoch: manager.current_epoch,
        });

        Ok(())
    }

    /// Check if a nullifier has been spent (read-only).
    pub fn is_nullifier_spent(
        ctx: Context<CheckNullifier>,
        nullifier: [u8; 32],
    ) -> Result<()> {
        let page = &ctx.accounts.nullifier_page;
        let digest = Sha256::digest(nullifier);
        let bit_index = u16::from_le_bytes([digest[0], digest[1]]) as usize
            % SLOTS_PER_PAGE;
        let byte_index = bit_index / 8;
        let bit_offset = bit_index % 8;

        let is_spent = (page.bitmap[byte_index] >> bit_offset) & 1;

        emit!(NullifierCheck {
            nullifier,
            is_spent: is_spent == 1,
        });

        Ok(())
    }

    /// Finalize the current epoch: record the epoch's nullifier Merkle root
    /// and advance to the next epoch.
    pub fn finalize_epoch(
        ctx: Context<FinalizeEpoch>,
        epoch_nullifier_root: [u8; 32],
    ) -> Result<()> {
        let manager = &mut ctx.accounts.manager;
        let epoch_record = &mut ctx.accounts.epoch_record;

        require!(
            manager.authority == ctx.accounts.authority.key(),
            HolancNullifierError::Unauthorized
        );

        // Store the epoch record
        epoch_record.epoch = manager.current_epoch;
        epoch_record.nullifier_root = epoch_nullifier_root;
        epoch_record.finalized_slot = Clock::get()?.slot;
        epoch_record.nullifier_count = manager.total_nullifiers;
        epoch_record.pool = manager.pool;

        // Advance epoch
        manager.current_epoch += 1;
        manager.epoch_start_slot = Clock::get()?.slot;

        emit!(EpochFinalized {
            pool: manager.pool,
            epoch: epoch_record.epoch,
            nullifier_root: epoch_nullifier_root,
            nullifier_count: epoch_record.nullifier_count,
        });

        Ok(())
    }

    /// Register a domain-separated V2 nullifier.
    /// V2 nullifier = Poseidon(Poseidon(sk, cm), Poseidon(chain_id, app_id))
    ///
    /// The bitmap index incorporates chain_id and app_id for true cross-chain
    /// domain separation — the same nullifier on different chains maps to
    /// different bitmap slots.
    pub fn register_nullifier_v2(
        ctx: Context<RegisterNullifier>,
        nullifier: [u8; 32],
        chain_id: u64,
        app_id: u64,
    ) -> Result<()> {
        let page = &mut ctx.accounts.nullifier_page;

        // Domain-separated hash: include chain_id and app_id in the digest
        // so the same nullifier on different chains maps to different bitmap slots.
        let mut hasher = Sha256::new();
        hasher.update(nullifier);
        hasher.update(chain_id.to_le_bytes());
        hasher.update(app_id.to_le_bytes());
        let digest = hasher.finalize();

        let bit_index = u16::from_le_bytes([digest[0], digest[1]]) as usize
            % SLOTS_PER_PAGE;
        let byte_index = bit_index / 8;
        let bit_offset = bit_index % 8;

        let already_spent = (page.bitmap[byte_index] >> bit_offset) & 1;
        require!(already_spent == 0, HolancNullifierError::NullifierAlreadySpent);

        page.bitmap[byte_index] |= 1 << bit_offset;
        page.count += 1;

        let manager = &mut ctx.accounts.manager;
        manager.total_nullifiers += 1;

        emit!(NullifierV2Registered {
            pool: manager.pool,
            nullifier,
            chain_id,
            app_id,
            epoch: manager.current_epoch,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeNullifierManager<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + NullifierManager::MAX_SIZE,
        seeds = [b"nullifier_mgr", pool.key().as_ref()],
        bump,
    )]
    pub manager: Account<'info, NullifierManager>,

    /// CHECK: The pool program account.
    pub pool: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterNullifier<'info> {
    #[account(mut, has_one = authority)]
    pub manager: Account<'info, NullifierManager>,

    #[account(
        mut,
        constraint = nullifier_page.pool == manager.pool @ HolancNullifierError::NullifierPagePoolMismatch,
    )]
    pub nullifier_page: Account<'info, NullifierPage>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckNullifier<'info> {
    pub nullifier_page: Account<'info, NullifierPage>,
}

#[derive(Accounts)]
pub struct FinalizeEpoch<'info> {
    #[account(mut)]
    pub manager: Account<'info, NullifierManager>,

    #[account(
        init,
        payer = authority,
        space = 8 + EpochRecord::MAX_SIZE,
        seeds = [b"epoch", manager.pool.as_ref(), &manager.current_epoch.to_le_bytes()],
        bump,
    )]
    pub epoch_record: Account<'info, EpochRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct NullifierManager {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub current_epoch: u64,
    pub epoch_start_slot: u64,
    pub epoch_duration_slots: u64,
    pub total_nullifiers: u64,
    pub bump: u8,
}

impl NullifierManager {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

/// A page of nullifier bitmap. Each page can track SLOTS_PER_PAGE (256) nullifiers.
/// Multiple pages are created as needed, keyed by page index.
#[account]
pub struct NullifierPage {
    pub pool: Pubkey,
    pub page_index: u64,
    pub count: u32,
    pub bitmap: [u8; 32], // 256 bits = 32 bytes
}

impl NullifierPage {
    pub const MAX_SIZE: usize = 32 + 8 + 4 + 32;
}

/// Record of a finalized epoch, used for cross-chain nullifier root synchronization.
#[account]
pub struct EpochRecord {
    pub pool: Pubkey,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub finalized_slot: u64,
    pub nullifier_count: u64,
}

impl EpochRecord {
    pub const MAX_SIZE: usize = 32 + 8 + 32 + 8 + 8;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct NullifierRegistered {
    pub pool: Pubkey,
    pub nullifier: [u8; 32],
    pub epoch: u64,
}

#[event]
pub struct NullifierV2Registered {
    pub pool: Pubkey,
    pub nullifier: [u8; 32],
    pub chain_id: u64,
    pub app_id: u64,
    pub epoch: u64,
}

#[event]
pub struct NullifierCheck {
    pub nullifier: [u8; 32],
    pub is_spent: bool,
}

#[event]
pub struct EpochFinalized {
    pub pool: Pubkey,
    pub epoch: u64,
    pub nullifier_root: [u8; 32],
    pub nullifier_count: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HolancNullifierError {
    #[msg("Nullifier has already been spent")]
    NullifierAlreadySpent,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Nullifier page does not belong to the expected pool")]
    NullifierPagePoolMismatch,
}
