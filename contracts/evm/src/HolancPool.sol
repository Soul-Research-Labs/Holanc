// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HolancVerifier} from "./HolancVerifier.sol";
import {HolancNullifier} from "./HolancNullifier.sol";

/// @title HolancPool — Privacy pool for shielded ERC-20 transactions.
/// @notice Ports the Solana holanc-pool program to EVM. Supports deposit, private transfer, and withdraw.
/// @dev Uses an incremental SHA-256 Merkle tree on-chain and delegates proof verification / nullifier
///      management to HolancVerifier and HolancNullifier respectively.
contract HolancPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Merkle tree depth for the commitment tree.
    uint256 public constant TREE_DEPTH = 20;

    /// Number of historical roots stored (ring buffer).
    uint256 public constant ROOT_HISTORY_SIZE = 100;

    /// Maximum notes per deposit/transfer/withdraw.
    uint256 public constant MAX_OUTPUTS = 2;

    /// Circuit types (must match the VK stored in the verifier).
    uint8 public constant CIRCUIT_TRANSFER = 1;
    uint8 public constant CIRCUIT_WITHDRAW = 2;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// The ERC-20 token this pool accepts.
    IERC20 public token;

    /// External verifier contract.
    HolancVerifier public verifier;

    /// External nullifier registry contract.
    HolancNullifier public nullifier;

    /// Bridge contract address (for commitment lock checks).
    address public bridge;

    /// Fee collector address.
    address public feeCollector;

    /// Next leaf index in the Merkle tree.
    uint64 public nextLeafIndex;

    /// Current Poseidon Merkle root (updated via updateRoot by relayer).
    bytes32 public currentRoot;

    /// Ring buffer of historical roots.
    bytes32[100] public rootHistory;
    uint8 public rootHistoryIndex;

    /// Total deposited token amount.
    uint256 public totalDeposited;

    /// Whether the pool is paused.
    bool public isPaused;

    /// Current epoch number.
    uint64 public epoch;

    /// Last commitment appended.
    bytes32 public lastCommitment;

    /// Incremental subtree hashes for on-chain SHA-256 Merkle tree.
    bytes32[20] public filledSubtrees;

    /// SHA-256 based root (computed on-chain for consistency verification).
    bytes32 public sha256Root;

    /// Pre-computed SHA-256 zero hashes per level.
    bytes32[20] internal _zeros;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PoolInitialized(address indexed token, address indexed authority);
    event DepositEvent(
        uint64 indexed leafIndex,
        bytes32 commitment,
        uint256 amount,
        bytes encryptedNote
    );
    event NewCommitment(
        uint64 indexed leafIndex,
        bytes32 commitment,
        bytes encryptedNote
    );
    event TransferEvent(
        bytes32[2] nullifiers,
        bytes32[2] outputCommitments,
        uint256 fee
    );
    event WithdrawEvent(
        bytes32[2] nullifiers,
        uint256 exitAmount,
        address indexed recipient,
        uint256 fee
    );
    event FeeCollected(uint256 amount);
    event RootUpdated(bytes32 newRoot);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error PoolPaused();
    error ZeroAmount();
    error EncryptedNoteTooLarge();
    error TreeFull();
    error UnknownMerkleRoot();
    error RootIntegrityMismatch();
    error InsufficientPoolBalance();
    error CommitmentBridgeLocked();
    error MissingEncryptedNote();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor(
        address _token,
        address _verifier,
        address _nullifier,
        address _feeCollector
    ) Ownable(msg.sender) {
        token = IERC20(_token);
        verifier = HolancVerifier(_verifier);
        nullifier = HolancNullifier(_nullifier);
        feeCollector = _feeCollector;

        // Pre-compute SHA-256 zero hashes for each tree level.
        _zeros[0] = sha256(abi.encodePacked(bytes32(0), bytes32(0)));
        for (uint256 i = 1; i < TREE_DEPTH; i++) {
            _zeros[i] = sha256(abi.encodePacked(_zeros[i - 1], _zeros[i - 1]));
        }

        emit PoolInitialized(_token, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Set the bridge contract address.
    function setBridge(address _bridge) external onlyOwner {
        bridge = _bridge;
    }

    /// @notice Emergency pause/unpause.
    function setPaused(bool _paused) external onlyOwner {
        isPaused = _paused;
    }

    /// @notice Update the fee collector address.
    function setFeeCollector(address _feeCollector) external onlyOwner {
        feeCollector = _feeCollector;
    }

    // -----------------------------------------------------------------------
    // Deposit
    // -----------------------------------------------------------------------

    /// @notice Deposit tokens into the privacy pool, creating a shielded note.
    /// @param amount      The token amount to deposit.
    /// @param commitment  Pre-computed note commitment: Poseidon(owner, value, asset_id, blinding).
    /// @param encryptedNote  Encrypted note data for off-chain indexing.
    function deposit(
        uint256 amount,
        bytes32 commitment,
        bytes calldata encryptedNote
    ) external nonReentrant {
        if (isPaused) revert PoolPaused();
        if (amount == 0) revert ZeroAmount();
        if (encryptedNote.length > 256) revert EncryptedNoteTooLarge();

        // Transfer tokens from depositor to pool
        token.safeTransferFrom(msg.sender, address(this), amount);

        uint64 leafIndex = nextLeafIndex;
        nextLeafIndex++;
        if (nextLeafIndex == 0) revert TreeFull(); // overflow check
        totalDeposited += amount;
        lastCommitment = commitment;

        // Incremental Merkle tree update using SHA-256
        _insertLeaf(leafIndex, commitment);

        emit DepositEvent(leafIndex, commitment, amount, encryptedNote);
    }

    // -----------------------------------------------------------------------
    // Private Transfer
    // -----------------------------------------------------------------------

    /// @notice Execute a private transfer within the pool.
    /// @param merkleRoot           The Merkle root the proof was generated against.
    /// @param nullifiers           Two input nullifiers.
    /// @param outputCommitments    Two output commitments.
    /// @param fee                  Relayer fee.
    /// @param encryptedNotes       Encrypted output notes for indexing.
    /// @param proofA               Groth16 proof element π_A.
    /// @param proofB               Groth16 proof element π_B.
    /// @param proofC               Groth16 proof element π_C.
    function transfer(
        bytes32 merkleRoot,
        bytes32[2] calldata nullifiers,
        bytes32[2] calldata outputCommitments,
        uint256 fee,
        bytes[] calldata encryptedNotes,
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC
    ) external nonReentrant {
        if (isPaused) revert PoolPaused();
        if (!_isKnownRoot(merkleRoot)) revert UnknownMerkleRoot();
        if (encryptedNotes.length != MAX_OUTPUTS) revert MissingEncryptedNote();

        // Check bridge locks
        _assertNotBridgeLocked(nullifiers[0]);
        _assertNotBridgeLocked(nullifiers[1]);

        // Build public inputs: root, nullifiers[2], commitments[2], fee
        uint256[] memory publicInputs = new uint256[](6);
        publicInputs[0] = uint256(merkleRoot);
        publicInputs[1] = uint256(nullifiers[0]);
        publicInputs[2] = uint256(nullifiers[1]);
        publicInputs[3] = uint256(outputCommitments[0]);
        publicInputs[4] = uint256(outputCommitments[1]);
        publicInputs[5] = fee;

        // Verify ZK proof
        verifier.verifyProof(
            CIRCUIT_TRANSFER,
            proofA,
            proofB,
            proofC,
            publicInputs
        );

        // Register nullifiers
        nullifier.registerNullifier(0, nullifiers[0]);
        nullifier.registerNullifier(0, nullifiers[1]);

        // Append output commitments
        for (uint256 i = 0; i < MAX_OUTPUTS; i++) {
            uint64 leafIndex = nextLeafIndex;
            nextLeafIndex++;
            if (nextLeafIndex == 0) revert TreeFull();

            emit NewCommitment(
                leafIndex,
                outputCommitments[i],
                encryptedNotes[i]
            );
        }

        // Collect fee
        if (fee > 0) {
            token.safeTransfer(feeCollector, fee);
            emit FeeCollected(fee);
        }

        emit TransferEvent(nullifiers, outputCommitments, fee);
    }

    // -----------------------------------------------------------------------
    // Withdraw
    // -----------------------------------------------------------------------

    /// @notice Withdraw tokens from the privacy pool back to a public address.
    /// @param merkleRoot           The Merkle root the proof was generated against.
    /// @param nullifiers           Two input nullifiers.
    /// @param outputCommitments    Two output change commitments.
    /// @param exitAmount           Amount to withdraw publicly.
    /// @param fee                  Relayer fee.
    /// @param recipient            Public ERC-20 recipient address.
    /// @param encryptedNotes       Encrypted change notes for indexing.
    /// @param proofA               Groth16 proof element π_A.
    /// @param proofB               Groth16 proof element π_B.
    /// @param proofC               Groth16 proof element π_C.
    function withdraw(
        bytes32 merkleRoot,
        bytes32[2] calldata nullifiers,
        bytes32[2] calldata outputCommitments,
        uint256 exitAmount,
        uint256 fee,
        address recipient,
        bytes[] calldata encryptedNotes,
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC
    ) external nonReentrant {
        if (isPaused) revert PoolPaused();
        if (exitAmount == 0) revert ZeroAmount();
        if (!_isKnownRoot(merkleRoot)) revert UnknownMerkleRoot();
        if (encryptedNotes.length != MAX_OUTPUTS) revert MissingEncryptedNote();

        // Check bridge locks
        _assertNotBridgeLocked(nullifiers[0]);
        _assertNotBridgeLocked(nullifiers[1]);

        // Build public inputs: root, nullifiers[2], commitments[2], exitAmount, fee
        uint256[] memory publicInputs = new uint256[](7);
        publicInputs[0] = uint256(merkleRoot);
        publicInputs[1] = uint256(nullifiers[0]);
        publicInputs[2] = uint256(nullifiers[1]);
        publicInputs[3] = uint256(outputCommitments[0]);
        publicInputs[4] = uint256(outputCommitments[1]);
        publicInputs[5] = exitAmount;
        publicInputs[6] = fee;

        // Verify ZK proof
        verifier.verifyProof(
            CIRCUIT_WITHDRAW,
            proofA,
            proofB,
            proofC,
            publicInputs
        );

        // Check balance
        if (exitAmount + fee > totalDeposited) revert InsufficientPoolBalance();

        // Register nullifiers
        nullifier.registerNullifier(0, nullifiers[0]);
        nullifier.registerNullifier(0, nullifiers[1]);

        // Transfer exit amount to recipient
        totalDeposited -= exitAmount;
        token.safeTransfer(recipient, exitAmount);

        // Append output commitments
        for (uint256 i = 0; i < MAX_OUTPUTS; i++) {
            uint64 leafIndex = nextLeafIndex;
            nextLeafIndex++;
            if (nextLeafIndex == 0) revert TreeFull();

            emit NewCommitment(
                leafIndex,
                outputCommitments[i],
                encryptedNotes[i]
            );
        }

        // Collect fee
        if (fee > 0) {
            totalDeposited -= fee;
            token.safeTransfer(feeCollector, fee);
            emit FeeCollected(fee);
        }

        emit WithdrawEvent(nullifiers, exitAmount, recipient, fee);
    }

    // -----------------------------------------------------------------------
    // Root Management
    // -----------------------------------------------------------------------

    /// @notice Update the Merkle root (called by relayer after off-chain Poseidon tree recomputation).
    /// @param newRoot              The new Poseidon Merkle root.
    /// @param expectedSha256Root   Must match the on-chain SHA-256 root for integrity.
    function updateRoot(
        bytes32 newRoot,
        bytes32 expectedSha256Root
    ) external onlyOwner {
        if (sha256Root != expectedSha256Root) revert RootIntegrityMismatch();

        currentRoot = newRoot;
        rootHistory[rootHistoryIndex] = newRoot;
        rootHistoryIndex = uint8(
            (uint256(rootHistoryIndex) + 1) % ROOT_HISTORY_SIZE
        );

        emit RootUpdated(newRoot);
    }

    // -----------------------------------------------------------------------
    // Internal Helpers
    // -----------------------------------------------------------------------

    /// @dev Incremental SHA-256 Merkle tree insert.
    function _insertLeaf(uint64 leafIndex, bytes32 leaf) internal {
        bytes32 current = leaf;
        uint64 idx = leafIndex;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            if (idx % 2 == 0) {
                filledSubtrees[level] = current;
                current = sha256(abi.encodePacked(current, _zeros[level]));
            } else {
                current = sha256(
                    abi.encodePacked(filledSubtrees[level], current)
                );
            }
            idx /= 2;
        }
        sha256Root = current;
    }

    /// @dev Check if a root is the current root or in the history.
    function _isKnownRoot(bytes32 root) internal view returns (bool) {
        if (currentRoot == root) return true;
        for (uint256 i = 0; i < ROOT_HISTORY_SIZE; i++) {
            if (rootHistory[i] == root) return true;
        }
        return false;
    }

    /// @dev Reject if a commitment is locked for bridge transfer.
    function _assertNotBridgeLocked(bytes32 commitment) internal view {
        if (bridge == address(0)) return; // no bridge configured

        // The bridge contract exposes isCommitmentLocked(bytes32) if a lock exists.
        // We use a low-level staticcall so a missing function doesn't revert.
        (bool success, bytes memory data) = bridge.staticcall(
            abi.encodeWithSignature("isCommitmentLocked(bytes32)", commitment)
        );
        if (success && data.length >= 32) {
            bool locked = abi.decode(data, (bool));
            if (locked) revert CommitmentBridgeLocked();
        }
    }
}
