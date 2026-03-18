// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HolancNullifier — Bitmap-based nullifier registry for Holanc.
/// @notice Ports the Solana holanc-nullifier program to EVM.
/// @dev Uses SHA-256 for bitmap index derivation matching the Solana implementation.
contract HolancNullifier is Ownable {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Number of nullifier slots per page (bitmap-based).
    uint256 public constant SLOTS_PER_PAGE = 2048;

    /// Bitmap size in bytes (SLOTS_PER_PAGE / 8).
    uint256 public constant BITMAP_BYTES = 256;

    /// Maximum number of epochs before forced rotation.
    uint256 public constant MAX_EPOCHS = 1024;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    struct NullifierPage {
        uint256[8] bitmap; // 8 × 32 bytes = 256 bytes = 2048 bits
        uint32 count;
        bool initialized;
    }

    struct EpochRecord {
        bytes32 nullifierRoot;
        uint256 finalizedBlock;
        uint64 nullifierCount;
    }

    /// Pool address this nullifier registry belongs to.
    address public pool;

    /// Authority that can register nullifiers (the pool contract).
    address public registrar;

    /// Current epoch number.
    uint64 public currentEpoch;

    /// Block at which the current epoch started.
    uint256 public epochStartBlock;

    /// Number of blocks per epoch (~1 day at 12s/block on Ethereum).
    uint256 public epochDurationBlocks;

    /// Total nullifiers registered across all epochs.
    uint64 public totalNullifiers;

    /// Page index → NullifierPage.
    mapping(uint64 => NullifierPage) internal _pages;

    /// Epoch number → EpochRecord.
    mapping(uint64 => EpochRecord) public epochRecords;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event NullifierRegistered(
        address indexed pool,
        bytes32 nullifier,
        uint64 epoch
    );
    event NullifierV2Registered(
        address indexed pool,
        bytes32 nullifier,
        uint64 chainId,
        uint64 appId,
        uint64 epoch
    );
    event EpochFinalized(
        address indexed pool,
        uint64 epoch,
        bytes32 nullifierRoot,
        uint64 nullifierCount
    );

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NullifierAlreadySpent();
    error Unauthorized();
    error PageNotInitialized();
    error AlreadyInitialized();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /// @notice Initialize the nullifier manager for a specific pool.
    /// @param _pool The pool contract address.
    /// @param _registrar The address authorized to register nullifiers (typically the pool).
    /// @param _epochDurationBlocks Number of blocks per epoch (~7200 for 1 day at 12s).
    function initialize(
        address _pool,
        address _registrar,
        uint256 _epochDurationBlocks
    ) external onlyOwner {
        if (pool != address(0)) revert AlreadyInitialized();
        pool = _pool;
        registrar = _registrar;
        epochStartBlock = block.number;
        epochDurationBlocks = _epochDurationBlocks;
    }

    // -----------------------------------------------------------------------
    // Core
    // -----------------------------------------------------------------------

    /// @notice Register a nullifier as spent.
    /// @param pageIndex The page to register the nullifier in.
    /// @param nullifier The 32-byte nullifier value.
    function registerNullifier(uint64 pageIndex, bytes32 nullifier) external {
        if (msg.sender != registrar) revert Unauthorized();

        NullifierPage storage page = _pages[pageIndex];
        if (!page.initialized) {
            page.initialized = true;
        }

        // SHA-256 hash for uniform bit distribution (matches Solana implementation).
        bytes32 digest = sha256(abi.encodePacked(nullifier));
        uint256 bitIndex = uint256(uint16(bytes2(digest))) % SLOTS_PER_PAGE;
        uint256 wordIndex = bitIndex / 256;
        uint256 bitOffset = bitIndex % 256;

        // Check not already spent
        if ((_pages[pageIndex].bitmap[wordIndex] >> bitOffset) & 1 == 1) {
            revert NullifierAlreadySpent();
        }

        // Mark as spent
        _pages[pageIndex].bitmap[wordIndex] |= (uint256(1) << bitOffset);
        _pages[pageIndex].count++;

        totalNullifiers++;

        emit NullifierRegistered(pool, nullifier, currentEpoch);
    }

    /// @notice Register a domain-separated V2 nullifier.
    /// @param pageIndex   The page to register the nullifier in.
    /// @param nullifier   The 32-byte nullifier value.
    /// @param chainId     Chain ID for domain separation.
    /// @param appId       Application ID for domain separation.
    function registerNullifierV2(
        uint64 pageIndex,
        bytes32 nullifier,
        uint64 chainId,
        uint64 appId
    ) external {
        if (msg.sender != registrar) revert Unauthorized();

        NullifierPage storage page = _pages[pageIndex];
        if (!page.initialized) {
            page.initialized = true;
        }

        // Domain-separated hash matching the Solana V2 implementation.
        bytes32 digest = sha256(abi.encodePacked(nullifier, chainId, appId));
        uint256 bitIndex = uint256(uint16(bytes2(digest))) % SLOTS_PER_PAGE;
        uint256 wordIndex = bitIndex / 256;
        uint256 bitOffset = bitIndex % 256;

        if ((page.bitmap[wordIndex] >> bitOffset) & 1 == 1) {
            revert NullifierAlreadySpent();
        }

        page.bitmap[wordIndex] |= (uint256(1) << bitOffset);
        page.count++;

        totalNullifiers++;

        emit NullifierV2Registered(
            pool,
            nullifier,
            chainId,
            appId,
            currentEpoch
        );
    }

    /// @notice Check if a nullifier has been spent.
    /// @param pageIndex The page to check.
    /// @param nullifier The 32-byte nullifier value.
    /// @return True if the nullifier is spent.
    function isNullifierSpent(
        uint64 pageIndex,
        bytes32 nullifier
    ) external view returns (bool) {
        NullifierPage storage page = _pages[pageIndex];
        if (!page.initialized) return false;

        bytes32 digest = sha256(abi.encodePacked(nullifier));
        uint256 bitIndex = uint256(uint16(bytes2(digest))) % SLOTS_PER_PAGE;
        uint256 wordIndex = bitIndex / 256;
        uint256 bitOffset = bitIndex % 256;

        return (page.bitmap[wordIndex] >> bitOffset) & 1 == 1;
    }

    /// @notice Finalize the current epoch and advance to the next one.
    /// @param epochNullifierRoot The Merkle root of all nullifiers in this epoch.
    function finalizeEpoch(bytes32 epochNullifierRoot) external onlyOwner {
        epochRecords[currentEpoch] = EpochRecord({
            nullifierRoot: epochNullifierRoot,
            finalizedBlock: block.number,
            nullifierCount: totalNullifiers
        });

        emit EpochFinalized(
            pool,
            currentEpoch,
            epochNullifierRoot,
            totalNullifiers
        );

        currentEpoch++;
        epochStartBlock = block.number;
    }
}
