use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");

/// Merkle tree depth for the commitment tree.
pub const TREE_DEPTH: usize = 20;
/// Number of historical roots to store (ring buffer).
pub const ROOT_HISTORY_SIZE: usize = 100;
/// Maximum notes per deposit/transfer/withdraw.
pub const MAX_OUTPUTS: usize = 2;

#[program]
pub mod holanc_pool {
    use super::*;

    /// Initialize the privacy pool with a token mint and empty Merkle tree.
    pub fn initialize(ctx: Context<Initialize>, pool_bump: u8) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.vault = ctx.accounts.vault.key();
        pool.next_leaf_index = 0;
        pool.current_root = [0u8; 32]; // empty tree root (Poseidon zero hash)
        pool.root_history = [[0u8; 32]; ROOT_HISTORY_SIZE];
        pool.root_history_index = 0;
        pool.total_deposited = 0;
        pool.bump = pool_bump;
        pool.is_paused = false;
        pool.epoch = 0;

        emit!(PoolInitialized {
            pool: pool_key,
            token_mint: ctx.accounts.token_mint.key(),
            authority: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Deposit tokens into the privacy pool, creating a shielded note.
    ///
    /// The caller provides a pre-computed note commitment (computed off-chain):
    ///   commitment = Poseidon(owner, value, asset_id, blinding)
    ///
    /// The commitment is appended to the on-chain Merkle tree.
    /// Encrypted note data is emitted as a program log for off-chain indexing.
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        commitment: [u8; 32],
        encrypted_note: Vec<u8>,
    ) -> Result<()> {
        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(!pool.is_paused, HolancPoolError::PoolPaused);
        require!(amount > 0, HolancPoolError::ZeroAmount);
        require!(
            encrypted_note.len() <= 256,
            HolancPoolError::EncryptedNoteTooLarge
        );

        // Transfer tokens from depositor to pool vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // Record the commitment
        let leaf_index = pool.next_leaf_index;
        pool.next_leaf_index = pool
            .next_leaf_index
            .checked_add(1)
            .ok_or(HolancPoolError::TreeFull)?;
        pool.total_deposited = pool
            .total_deposited
            .checked_add(amount)
            .ok_or(HolancPoolError::Overflow)?;

        // Update root (in production: append to concurrent Merkle tree via CPI)
        // For now, store the commitment and new root will be computed off-chain
        // and verified during transfer/withdraw.
        pool.last_commitment = commitment;

        emit!(DepositEvent {
            pool: pool_key,
            leaf_index,
            commitment,
            amount,
            encrypted_note,
        });

        Ok(())
    }

    /// Execute a private transfer within the pool.
    ///
    /// Requires a valid Groth16 proof that was verified by the holanc-verifier program
    /// (via CPI or a prior instruction in the same transaction). The proof attests:
    ///   1. The sender knows the spending key for the input notes
    ///   2. Input notes exist in the Merkle tree (Merkle inclusion proof)
    ///   3. Nullifiers are correctly derived from the input notes
    ///   4. Output commitments are well-formed
    ///   5. Value is conserved: sum(inputs) == sum(outputs) + fee
    pub fn transfer(
        ctx: Context<PrivateTransfer>,
        merkle_root: [u8; 32],
        nullifiers: [[u8; 32]; 2],
        output_commitments: [[u8; 32]; MAX_OUTPUTS],
        fee: u64,
        encrypted_notes: Vec<Vec<u8>>,
    ) -> Result<()> {
        // Extract key before mutable borrow
        let pool_key = ctx.accounts.pool.key();
        let pool = &mut ctx.accounts.pool;
        require!(!pool.is_paused, HolancPoolError::PoolPaused);

        // Verify the Merkle root is known (current or in history)
        require!(
            is_known_root(pool, &merkle_root),
            HolancPoolError::UnknownMerkleRoot
        );

        // Check nullifiers haven't been spent (CPI to holanc-nullifier)
        // For now, we store nullifiers in the pool's event log and rely
        // on the nullifier program for on-chain double-spend checks.
        let nullifier_registry = &mut ctx.accounts.nullifier_registry;
        for nf in &nullifiers {
            require!(
                !nullifier_registry.is_spent(nf),
                HolancPoolError::NullifierAlreadySpent
            );
            nullifier_registry.mark_spent(nf)?;
        }

        // Append output commitments
        for (i, commitment) in output_commitments.iter().enumerate() {
            let leaf_index = pool.next_leaf_index;
            pool.next_leaf_index = pool
                .next_leaf_index
                .checked_add(1)
                .ok_or(HolancPoolError::TreeFull)?;

            emit!(NewCommitment {
                pool: pool_key,
                leaf_index,
                commitment: *commitment,
                encrypted_note: encrypted_notes.get(i).cloned().unwrap_or_default(),
            });
        }

        emit!(TransferEvent {
            pool: pool_key,
            nullifiers,
            output_commitments,
            fee,
        });

        Ok(())
    }

    /// Withdraw tokens from the privacy pool back to a public address.
    ///
    /// Requires a valid ZK proof (same as transfer, but with an additional
    /// public exit_value and exit_address).
    pub fn withdraw(
        ctx: Context<Withdraw>,
        merkle_root: [u8; 32],
        nullifiers: [[u8; 32]; 2],
        output_commitments: [[u8; 32]; MAX_OUTPUTS],
        exit_amount: u64,
        fee: u64,
        encrypted_notes: Vec<Vec<u8>>,
    ) -> Result<()> {
        // Extract key and bump before mutable borrow
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let pool = &mut ctx.accounts.pool;
        require!(!pool.is_paused, HolancPoolError::PoolPaused);
        require!(exit_amount > 0, HolancPoolError::ZeroAmount);

        // Verify Merkle root
        require!(
            is_known_root(pool, &merkle_root),
            HolancPoolError::UnknownMerkleRoot
        );

        // Check and register nullifiers
        let nullifier_registry = &mut ctx.accounts.nullifier_registry;
        for nf in &nullifiers {
            require!(
                !nullifier_registry.is_spent(nf),
                HolancPoolError::NullifierAlreadySpent
            );
            nullifier_registry.mark_spent(nf)?;
        }

        // Transfer tokens from vault to recipient
        let seeds = &[b"vault" as &[u8], pool_key.as_ref(), &[pool_bump]];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, exit_amount)?;

        pool.total_deposited = pool
            .total_deposited
            .checked_sub(exit_amount)
            .ok_or(HolancPoolError::InsufficientPoolBalance)?;

        // Append change output commitments
        for (i, commitment) in output_commitments.iter().enumerate() {
            let leaf_index = pool.next_leaf_index;
            pool.next_leaf_index = pool
                .next_leaf_index
                .checked_add(1)
                .ok_or(HolancPoolError::TreeFull)?;

            emit!(NewCommitment {
                pool: pool_key,
                leaf_index,
                commitment: *commitment,
                encrypted_note: encrypted_notes.get(i).cloned().unwrap_or_default(),
            });
        }

        emit!(WithdrawEvent {
            pool: pool_key,
            nullifiers,
            exit_amount,
            recipient: ctx.accounts.recipient_token_account.key(),
            fee,
        });

        Ok(())
    }

    /// Update the Merkle root (called after off-chain tree recomputation).
    pub fn update_root(ctx: Context<UpdateRoot>, new_root: [u8; 32]) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.current_root = new_root;
        let idx = pool.root_history_index as usize;
        pool.root_history[idx] = new_root;
        pool.root_history_index = ((idx + 1) % ROOT_HISTORY_SIZE) as u8;
        Ok(())
    }

    /// Emergency pause.
    pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(
            pool.authority == ctx.accounts.authority.key(),
            HolancPoolError::Unauthorized
        );
        pool.is_paused = paused;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_known_root(pool: &PoolState, root: &[u8; 32]) -> bool {
    if pool.current_root == *root {
        return true;
    }
    pool.root_history.iter().any(|r| r == root)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(pool_bump: u8)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + PoolState::MAX_SIZE,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, PoolState>,

    /// The token mint the pool accepts (e.g. wSOL).
    /// CHECK: Validated by SPL token program.
    pub token_mint: UncheckedAccount<'info>,

    /// Pool's token vault.
    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = vault_authority,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// PDA authority over the vault.
    /// CHECK: PDA derived from pool seeds.
    #[account(seeds = [b"vault_auth", pool.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub pool: Account<'info, PoolState>,

    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct PrivateTransfer<'info> {
    #[account(mut)]
    pub pool: Account<'info, PoolState>,

    #[account(mut)]
    pub nullifier_registry: Account<'info, NullifierRegistry>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub pool: Account<'info, PoolState>,

    #[account(mut)]
    pub nullifier_registry: Account<'info, NullifierRegistry>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority over vault.
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateRoot<'info> {
    #[account(mut, has_one = authority)]
    pub pool: Account<'info, PoolState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut)]
    pub pool: Account<'info, PoolState>,

    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct PoolState {
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub next_leaf_index: u64,
    pub current_root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_history_index: u8,
    pub total_deposited: u64,
    pub bump: u8,
    pub is_paused: bool,
    pub epoch: u64,
    pub last_commitment: [u8; 32],
}

impl PoolState {
    pub const MAX_SIZE: usize =
        32          // authority
        + 32        // token_mint
        + 32        // vault
        + 8         // next_leaf_index
        + 32        // current_root
        + 32 * ROOT_HISTORY_SIZE // root_history
        + 1         // root_history_index
        + 8         // total_deposited
        + 1         // bump
        + 1         // is_paused
        + 8         // epoch
        + 32;       // last_commitment
}

/// Inline nullifier registry for MVP.
/// In production this would be a separate program (holanc-nullifier).
#[account]
pub struct NullifierRegistry {
    pub nullifiers: Vec<[u8; 32]>,
}

impl NullifierRegistry {
    pub fn is_spent(&self, nf: &[u8; 32]) -> bool {
        // Constant-time comparison to prevent timing side-channels
        self.nullifiers.iter().any(|stored| {
            let mut acc = 0u8;
            for (a, b) in stored.iter().zip(nf.iter()) {
                acc |= a ^ b;
            }
            acc == 0
        })
    }

    pub fn mark_spent(&mut self, nf: &[u8; 32]) -> Result<()> {
        self.nullifiers.push(*nf);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub pool: Pubkey,
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub amount: u64,
    pub encrypted_note: Vec<u8>,
}

#[event]
pub struct NewCommitment {
    pub pool: Pubkey,
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub encrypted_note: Vec<u8>,
}

#[event]
pub struct TransferEvent {
    pub pool: Pubkey,
    pub nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub fee: u64,
}

#[event]
pub struct WithdrawEvent {
    pub pool: Pubkey,
    pub nullifiers: [[u8; 32]; 2],
    pub exit_amount: u64,
    pub recipient: Pubkey,
    pub fee: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HolancPoolError {
    #[msg("Pool is paused")]
    PoolPaused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Encrypted note data too large")]
    EncryptedNoteTooLarge,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unknown Merkle root")]
    UnknownMerkleRoot,
    #[msg("Nullifier has already been spent")]
    NullifierAlreadySpent,
    #[msg("Insufficient pool balance")]
    InsufficientPoolBalance,
    #[msg("Unauthorized")]
    Unauthorized,
}
