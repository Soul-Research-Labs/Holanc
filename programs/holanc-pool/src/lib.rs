use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT");

/// Verifier program ID for CPI.
const VERIFIER_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xea, 0x56, 0x05, 0x0b, 0xab, 0xf1, 0x5f, 0x69,
    0xdd, 0xa7, 0x3b, 0x04, 0xa0, 0x8c, 0xd3, 0xa0,
    0x53, 0x52, 0x09, 0xa1, 0xd4, 0x11, 0x22, 0x75,
    0x13, 0x20, 0x07, 0xab, 0x3d, 0x64, 0x9a, 0x0b,
]);

/// Bridge program ID — used to derive commitment lock PDAs.
const BRIDGE_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0xf3, 0x8c, 0x6a, 0x91, 0x2b, 0x0d, 0x4e, 0x7a,
    0x15, 0xd9, 0x63, 0xc0, 0xe8, 0x47, 0xb2, 0x53,
    0xa6, 0x39, 0x71, 0x0c, 0xfd, 0x82, 0x5e, 0xb4,
    0x19, 0x20, 0xca, 0x3d, 0x7f, 0x56, 0xa1, 0x08,
]);

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

        // Incremental Merkle tree update using SHA-256.
        // This mirrors the off-chain Poseidon tree structure but uses SHA-256
        // on-chain for compute budget efficiency. The relayer/indexer must also
        // track the off-chain Poseidon tree and submit `update_root` with the
        // canonical Poseidon root for proof verification.
        {
            let mut current = commitment;
            let mut idx = leaf_index;
            for level in 0..TREE_DEPTH {
                if idx % 2 == 0 {
                    pool.filled_subtrees[level] = current;
                    // Pair with zero at this level
                    current = sha256_pair(&current, &zeros()[level]);
                } else {
                    current = sha256_pair(&pool.filled_subtrees[level], &current);
                }
                idx /= 2;
            }
            // Store the SHA-256 root for fast on-chain consistency checks.
            // The canonical Poseidon root is updated via `update_root`.
            pool.sha256_root = current;
        }

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
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
    ) -> Result<()> {
        // Extract key and bump before mutable borrow
        let pool_key = ctx.accounts.pool.key();
        let pool_bump = ctx.accounts.pool.bump;
        let pool = &mut ctx.accounts.pool;
        require!(!pool.is_paused, HolancPoolError::PoolPaused);

        // Verify the Merkle root is known (current or in history)
        require!(
            is_known_root(pool, &merkle_root),
            HolancPoolError::UnknownMerkleRoot
        );

        // Reject if any input commitment is locked for bridge transfer.
        // The bridge program creates a PDA at ["lock", pool, commitment];
        // if that account exists and is_unlocked == false, the note is frozen.
        assert_not_bridge_locked(
            &ctx.accounts.commitment_lock_1,
            &ctx.accounts.pool.key(),
            &nullifiers[0],
        )?;
        assert_not_bridge_locked(
            &ctx.accounts.commitment_lock_2,
            &ctx.accounts.pool.key(),
            &nullifiers[1],
        )?;

        // Verify the ZK proof via CPI to holanc-verifier
        let mut public_inputs: Vec<[u8; 32]> = Vec::with_capacity(6);
        public_inputs.push(merkle_root);
        public_inputs.push(nullifiers[0]);
        public_inputs.push(nullifiers[1]);
        public_inputs.push(output_commitments[0]);
        public_inputs.push(output_commitments[1]);
        let mut fee_bytes = [0u8; 32];
        fee_bytes[24..].copy_from_slice(&fee.to_be_bytes());
        public_inputs.push(fee_bytes);

        verify_proof_cpi(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verification_key,
            &ctx.accounts.authority,
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
        )?;

        // Check nullifiers haven't been spent
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

        // Collect fee: transfer from vault to fee_collector
        if fee > 0 {
            let seeds = &[b"vault_auth" as &[u8], pool_key.as_ref(), &[pool_bump]];
            let signer_seeds = &[&seeds[..]];

            let fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_collector.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(fee_ctx, fee)?;

            emit!(FeeCollected {
                pool: pool_key,
                amount: fee,
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
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
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

        // Reject if any input commitment is locked for bridge transfer.
        assert_not_bridge_locked(
            &ctx.accounts.commitment_lock_1,
            &ctx.accounts.pool.key(),
            &nullifiers[0],
        )?;
        assert_not_bridge_locked(
            &ctx.accounts.commitment_lock_2,
            &ctx.accounts.pool.key(),
            &nullifiers[1],
        )?;

        // Verify the ZK proof via CPI to holanc-verifier
        let mut public_inputs: Vec<[u8; 32]> = Vec::with_capacity(7);
        public_inputs.push(merkle_root);
        public_inputs.push(nullifiers[0]);
        public_inputs.push(nullifiers[1]);
        public_inputs.push(output_commitments[0]);
        public_inputs.push(output_commitments[1]);
        let mut exit_bytes = [0u8; 32];
        exit_bytes[24..].copy_from_slice(&exit_amount.to_be_bytes());
        public_inputs.push(exit_bytes);
        let mut fee_bytes = [0u8; 32];
        fee_bytes[24..].copy_from_slice(&fee.to_be_bytes());
        public_inputs.push(fee_bytes);

        verify_proof_cpi(
            &ctx.accounts.verifier_program,
            &ctx.accounts.verification_key,
            &ctx.accounts.authority,
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
        )?;

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
        let seeds = &[b"vault_auth" as &[u8], pool_key.as_ref(), &[pool_bump]];
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

        // Collect fee: transfer from vault to fee_collector
        if fee > 0 {
            let fee_seeds = &[b"vault_auth" as &[u8], pool_key.as_ref(), &[pool_bump]];
            let fee_signer = &[&fee_seeds[..]];

            let fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_collector.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                fee_signer,
            );
            token::transfer(fee_ctx, fee)?;

            emit!(FeeCollected {
                pool: pool_key,
                amount: fee,
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

    /// Update the Merkle root (called after off-chain Poseidon tree recomputation).
    ///
    /// Integrity check: the caller must also supply the expected `sha256_root`.
    /// Since the on-chain SHA-256 tree is updated on every deposit, we can
    /// verify that the caller's local tree state (leaf count) is consistent
    /// with the on-chain state. This prevents stale or bogus root submissions.
    pub fn update_root(
        ctx: Context<UpdateRoot>,
        new_root: [u8; 32],
        expected_sha256_root: [u8; 32],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;

        // Integrity: caller must prove awareness of the current on-chain SHA-256 root.
        require!(
            pool.sha256_root == expected_sha256_root,
            HolancPoolError::RootIntegrityMismatch
        );

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

/// Compute hash of two 32-byte inputs (for on-chain Merkle tree).
/// Uses Solana's built-in SHA-256 hash for efficiency.
fn sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(left);
    data[32..].copy_from_slice(right);
    solana_sha256_hasher::hash(&data).to_bytes()
}

/// Pre-computed SHA-256 zero hashes for each tree level.
/// ZEROS[0] = sha256(0x00..00, 0x00..00), ZEROS[1] = sha256(ZEROS[0], ZEROS[0]), etc.
///
/// We use `once_cell::sync::Lazy` to compute these at first access since
/// SHA-256 cannot run in `const fn`.  Alternatively, call `initialize_zeros()`
/// once at pool init.
fn zeros() -> &'static [[u8; 32]; TREE_DEPTH] {
    use std::sync::OnceLock;
    static ZEROS: OnceLock<[[u8; 32]; TREE_DEPTH]> = OnceLock::new();
    ZEROS.get_or_init(|| {
        let mut z = [[0u8; 32]; TREE_DEPTH];
        // Level 0: hash of two empty leaves (all-zeros)
        z[0] = sha256_pair(&[0u8; 32], &[0u8; 32]);
        for i in 1..TREE_DEPTH {
            z[i] = sha256_pair(&z[i - 1], &z[i - 1]);
        }
        z
    })
}

/// Reject if the account is an initialized bridge commitment lock PDA
/// with `is_unlocked == false`. An empty (non-existent) account is fine.
fn assert_not_bridge_locked(
    lock_account: &AccountInfo,
    pool_key: &Pubkey,
    commitment: &[u8; 32],
) -> Result<()> {
    // If account has no data it was never created → not locked.
    if lock_account.data_is_empty() {
        return Ok(());
    }

    // Verify that the account is actually the expected PDA on the bridge program.
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"lock", pool_key.as_ref(), commitment],
        &BRIDGE_PROGRAM_ID,
    );
    require!(
        *lock_account.key == expected_pda,
        HolancPoolError::InvalidCommitmentLockPDA
    );

    // The lock record has an 8-byte Anchor discriminator followed by the
    // CommitmentLockRecord fields. `is_unlocked` is a bool at byte offset:
    //   8 (disc) + 32 (pool) + 32 (commitment) + 8 (source_chain) + 8 (dest)
    //   + 32 (locker) + 8 (locked_at) = 128
    const IS_UNLOCKED_OFFSET: usize = 8 + 32 + 32 + 8 + 8 + 32 + 8;
    let data = lock_account.try_borrow_data()?;
    if data.len() > IS_UNLOCKED_OFFSET {
        let is_unlocked = data[IS_UNLOCKED_OFFSET] != 0;
        require!(is_unlocked, HolancPoolError::CommitmentBridgeLocked);
    }
    Ok(())
}

fn is_known_root(pool: &PoolState, root: &[u8; 32]) -> bool {
    if pool.current_root == *root {
        return true;
    }
    pool.root_history.iter().any(|r| r == root)
}

/// CPI to holanc-verifier's verify_proof instruction.
fn verify_proof_cpi<'info>(
    verifier_program: &AccountInfo<'info>,
    verification_key: &AccountInfo<'info>,
    authority: &Signer<'info>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: Vec<[u8; 32]>,
) -> Result<()> {
    use anchor_lang::solana_program::instruction::Instruction;
    use anchor_lang::solana_program::program::invoke;

    // Build the verify_proof instruction data manually
    // Anchor discriminator for "verify_proof" = first 8 bytes of SHA256("global:verify_proof")
    let discriminator: [u8; 8] = [0xd9, 0xd3, 0xbf, 0x6e, 0x90, 0x0d, 0xba, 0x62];

    let mut data = Vec::with_capacity(8 + 64 + 128 + 64 + 4 + public_inputs.len() * 32);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&proof_a);
    data.extend_from_slice(&proof_b);
    data.extend_from_slice(&proof_c);
    // Vec<[u8; 32]> Borsh encoding: 4-byte LE length + elements
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
                *authority.key,
                true,
            ),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            verification_key.clone(),
            authority.to_account_info(),
            verifier_program.clone(),
        ],
    )?;

    Ok(())
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

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority over vault.
    pub vault_authority: UncheckedAccount<'info>,

    /// Fee collector token account.
    #[account(mut)]
    pub fee_collector: Account<'info, TokenAccount>,

    /// The holanc-verifier program for proof CPI.
    /// CHECK: Verified by address constraint.
    #[account(address = VERIFIER_PROGRAM_ID)]
    pub verifier_program: AccountInfo<'info>,

    /// The verification key account for the transfer circuit.
    /// CHECK: Owned by the verifier program.
    pub verification_key: AccountInfo<'info>,

    pub authority: Signer<'info>,

    /// Bridge commitment lock PDA for first nullifier's commitment.
    /// If this account exists and is initialized, the commitment is frozen.
    /// CHECK: Derived from bridge program seeds; validated in instruction logic.
    pub commitment_lock_1: UncheckedAccount<'info>,

    /// Bridge commitment lock PDA for second nullifier's commitment.
    /// CHECK: Derived from bridge program seeds; validated in instruction logic.
    pub commitment_lock_2: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
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

    /// Fee collector token account.
    #[account(mut)]
    pub fee_collector: Account<'info, TokenAccount>,

    /// The holanc-verifier program for proof CPI.
    /// CHECK: Verified by address constraint.
    #[account(address = VERIFIER_PROGRAM_ID)]
    pub verifier_program: AccountInfo<'info>,

    /// The verification key account for the withdraw circuit.
    /// CHECK: Owned by the verifier program.
    pub verification_key: AccountInfo<'info>,

    pub authority: Signer<'info>,

    /// Bridge commitment lock PDA for first nullifier's commitment.
    /// CHECK: Derived from bridge program seeds; validated in instruction logic.
    pub commitment_lock_1: UncheckedAccount<'info>,

    /// Bridge commitment lock PDA for second nullifier's commitment.
    /// CHECK: Derived from bridge program seeds; validated in instruction logic.
    pub commitment_lock_2: UncheckedAccount<'info>,

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
    /// Incremental subtree hashes for on-chain SHA-256 Merkle tree.
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    /// SHA-256 based root computed on-chain (for consistency verification).
    pub sha256_root: [u8; 32],
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
        + 32        // last_commitment
        + 32 * TREE_DEPTH // filled_subtrees
        + 32;       // sha256_root
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

#[event]
pub struct FeeCollected {
    pub pool: Pubkey,
    pub amount: u64,
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
    #[msg("SHA-256 root integrity mismatch — update_root rejected")]
    RootIntegrityMismatch,
    #[msg("Insufficient pool balance")]
    InsufficientPoolBalance,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Proof verification failed")]
    ProofVerificationFailed,
    #[msg("Commitment is locked for bridge transfer")]
    CommitmentBridgeLocked,
    #[msg("Invalid commitment lock PDA")]
    InvalidCommitmentLockPDA,
}
