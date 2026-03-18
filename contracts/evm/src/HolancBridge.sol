// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HolancBridge — Cross-chain epoch root synchronization via LayerZero V2.
/// @notice Ports the Solana holanc-bridge program to EVM. Replaces Wormhole VAAs
///         with LayerZero V2 messaging patterns.
/// @dev In production, this contract would inherit from LayerZero's OApp base contract.
///      For now, provides the core state machine and message format.
contract HolancBridge is Ownable {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Maximum stored foreign roots.
    uint256 public constant MAX_FOREIGN_ROOTS = 32;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    struct OutboundMessage {
        uint64 sourceChain;
        uint64 sourceApp;
        uint64 epoch;
        bytes32 nullifierRoot;
        uint64 nullifierCount;
        int64 timestamp;
        uint64 sequence;
    }

    struct ForeignRoot {
        uint64 sourceChain;
        uint64 epoch;
        bytes32 nullifierRoot;
        uint64 nullifierCount;
        bytes32 messageHash;
        int64 receivedAt;
    }

    struct CommitmentLock {
        bytes32 commitment;
        uint64 sourceChain;
        uint64 destinationChain;
        address locker;
        int64 lockedAt;
        bool isUnlocked;
        bytes32 proofHash;
    }

    struct UnlockRecord {
        bytes32 commitment;
        uint64 sourceChain;
        bytes32 messageHash;
        int64 unlockedAt;
    }

    /// Pool address this bridge serves.
    address public pool;

    /// Local chain ID.
    uint64 public localChainId;

    /// Local app ID.
    uint64 public localAppId;

    /// Outbound message sequence counter.
    uint64 public epochCounter;

    /// Whether the bridge is active.
    bool public isActive;

    /// LayerZero endpoint address (for production integration).
    address public lzEndpoint;

    /// Outbound messages (sequence → message).
    mapping(uint64 => OutboundMessage) public outboundMessages;

    /// Foreign roots: sourceChain → epoch → ForeignRoot.
    mapping(uint64 => mapping(uint64 => ForeignRoot)) public foreignRoots;

    /// Commitment locks: commitment hash → CommitmentLock.
    mapping(bytes32 => CommitmentLock) public commitmentLocks;

    /// Unlock records: keccak256(sourceChain, commitment) → UnlockRecord.
    mapping(bytes32 => UnlockRecord) public unlockRecords;

    /// Trusted remote peers: chainId → peer address (bytes32 for cross-chain compat).
    mapping(uint64 => bytes32) public trustedPeers;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event EpochRootPublished(
        uint64 indexed chainId,
        uint64 epoch,
        bytes32 nullifierRoot,
        uint64 nullifierCount,
        uint64 sequence
    );
    event ForeignRootReceived(
        uint64 indexed sourceChain,
        uint64 epoch,
        bytes32 nullifierRoot,
        uint64 nullifierCount,
        bytes32 messageHash
    );
    event CommitmentLocked(
        bytes32 indexed commitment,
        uint64 sourceChain,
        uint64 destinationChain,
        address locker
    );
    event CommitmentUnlocked(
        bytes32 indexed commitment,
        uint64 sourceChain,
        bytes32 messageHash
    );
    event PeerSet(uint64 indexed chainId, bytes32 peer);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error BridgeInactive();
    error CannotReceiveOwnChain();
    error CannotBridgeToSelf();
    error InvalidMerkleProof();
    error Unauthorized();
    error UntrustedPeer();
    error CommitmentAlreadyLocked();
    error AlreadyInitialized();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /// @notice Initialize the bridge configuration.
    /// @param _pool        The pool contract address.
    /// @param _localChainId  This chain's ID.
    /// @param _localAppId    This app's ID.
    /// @param _lzEndpoint    LayerZero V2 endpoint address.
    function initialize(
        address _pool,
        uint64 _localChainId,
        uint64 _localAppId,
        address _lzEndpoint
    ) external onlyOwner {
        if (pool != address(0)) revert AlreadyInitialized();
        pool = _pool;
        localChainId = _localChainId;
        localAppId = _localAppId;
        lzEndpoint = _lzEndpoint;
        isActive = true;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Set a trusted peer for a remote chain.
    function setTrustedPeer(uint64 chainId, bytes32 peer) external onlyOwner {
        trustedPeers[chainId] = peer;
        emit PeerSet(chainId, peer);
    }

    /// @notice Pause/unpause the bridge.
    function setActive(bool _active) external onlyOwner {
        isActive = _active;
    }

    // -----------------------------------------------------------------------
    // Epoch Root Publishing
    // -----------------------------------------------------------------------

    /// @notice Publish a local epoch nullifier root for cross-chain consumption.
    /// @param _epoch           The epoch number.
    /// @param nullifierRoot    The nullifier Merkle root.
    /// @param nullifierCount   Number of nullifiers in this epoch.
    function publishEpochRoot(
        uint64 _epoch,
        bytes32 nullifierRoot,
        uint64 nullifierCount
    ) external onlyOwner {
        if (!isActive) revert BridgeInactive();

        outboundMessages[epochCounter] = OutboundMessage({
            sourceChain: localChainId,
            sourceApp: localAppId,
            epoch: _epoch,
            nullifierRoot: nullifierRoot,
            nullifierCount: nullifierCount,
            timestamp: int64(int256(block.timestamp)),
            sequence: epochCounter
        });

        emit EpochRootPublished(
            localChainId,
            _epoch,
            nullifierRoot,
            nullifierCount,
            epochCounter
        );

        epochCounter++;

        // In production: call lzEndpoint.send() to dispatch the message
        // via LayerZero V2 to all registered peer chains.
    }

    // -----------------------------------------------------------------------
    // Foreign Root Reception
    // -----------------------------------------------------------------------

    /// @notice Receive a foreign chain's epoch root (via LayerZero message or relayer).
    /// @param sourceChain      The originating chain ID.
    /// @param _epoch           The epoch number.
    /// @param nullifierRoot    The nullifier Merkle root.
    /// @param nullifierCount   Number of nullifiers.
    /// @param messageHash      Hash of the cross-chain message for verification.
    function receiveEpochRoot(
        uint64 sourceChain,
        uint64 _epoch,
        bytes32 nullifierRoot,
        uint64 nullifierCount,
        bytes32 messageHash
    ) external onlyOwner {
        if (!isActive) revert BridgeInactive();
        if (sourceChain == localChainId) revert CannotReceiveOwnChain();

        // Verify body hash integrity
        bytes32 computedHash = sha256(
            abi.encodePacked(sourceChain, _epoch, nullifierRoot, nullifierCount)
        );
        if (computedHash != messageHash) revert InvalidMerkleProof();

        foreignRoots[sourceChain][_epoch] = ForeignRoot({
            sourceChain: sourceChain,
            epoch: _epoch,
            nullifierRoot: nullifierRoot,
            nullifierCount: nullifierCount,
            messageHash: messageHash,
            receivedAt: int64(int256(block.timestamp))
        });

        emit ForeignRootReceived(
            sourceChain,
            _epoch,
            nullifierRoot,
            nullifierCount,
            messageHash
        );
    }

    // -----------------------------------------------------------------------
    // Commitment Locking (Cross-Chain Transfer)
    // -----------------------------------------------------------------------

    /// @notice Lock a note commitment for cross-chain transfer.
    /// @param commitment         The commitment to lock.
    /// @param destinationChain   Target chain ID.
    /// @param proof              ZK proof data (hashed and stored).
    function lockCommitment(
        bytes32 commitment,
        uint64 destinationChain,
        bytes calldata proof
    ) external {
        if (!isActive) revert BridgeInactive();
        if (destinationChain == localChainId) revert CannotBridgeToSelf();
        if (commitmentLocks[commitment].lockedAt != 0)
            revert CommitmentAlreadyLocked();

        commitmentLocks[commitment] = CommitmentLock({
            commitment: commitment,
            sourceChain: localChainId,
            destinationChain: destinationChain,
            locker: msg.sender,
            lockedAt: int64(int256(block.timestamp)),
            isUnlocked: false,
            proofHash: sha256(proof)
        });

        emit CommitmentLocked(
            commitment,
            localChainId,
            destinationChain,
            msg.sender
        );
    }

    /// @notice Unlock a bridged commitment on the destination chain.
    /// @param commitment     The commitment to unlock.
    /// @param sourceChain    The chain where it was locked.
    /// @param messageHash    The cross-chain message hash proving the lock.
    function unlockCommitment(
        bytes32 commitment,
        uint64 sourceChain,
        bytes32 messageHash
    ) external onlyOwner {
        if (!isActive) revert BridgeInactive();
        if (sourceChain == localChainId) revert CannotReceiveOwnChain();

        bytes32 key = keccak256(abi.encodePacked(sourceChain, commitment));
        unlockRecords[key] = UnlockRecord({
            commitment: commitment,
            sourceChain: sourceChain,
            messageHash: messageHash,
            unlockedAt: int64(int256(block.timestamp))
        });

        emit CommitmentUnlocked(commitment, sourceChain, messageHash);
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    /// @notice Check if a commitment is locked for bridge transfer.
    /// @param commitment The commitment to check.
    /// @return True if locked and not yet unlocked.
    function isCommitmentLocked(
        bytes32 commitment
    ) external view returns (bool) {
        CommitmentLock storage lock = commitmentLocks[commitment];
        return lock.lockedAt != 0 && !lock.isUnlocked;
    }

    /// @notice Verify a foreign nullifier Merkle proof.
    /// @param sourceChain    The source chain.
    /// @param _epoch         The epoch.
    /// @param _nullifier     The nullifier to verify.
    /// @param proofPath      Merkle proof siblings.
    /// @param proofIndices   Left/right indicators for each sibling.
    /// @return True if the nullifier is included in the foreign root.
    function verifyForeignNullifier(
        uint64 sourceChain,
        uint64 _epoch,
        bytes32 _nullifier,
        bytes32[] calldata proofPath,
        uint8[] calldata proofIndices
    ) external view returns (bool) {
        ForeignRoot storage root = foreignRoots[sourceChain][_epoch];
        if (root.receivedAt == 0) return false;

        bytes32 computed = _nullifier;
        for (uint256 i = 0; i < proofPath.length; i++) {
            uint8 idx = i < proofIndices.length ? proofIndices[i] : 0;
            if (idx == 0) {
                computed = sha256(abi.encodePacked(computed, proofPath[i]));
            } else {
                computed = sha256(abi.encodePacked(proofPath[i], computed));
            }
        }

        return computed == root.nullifierRoot;
    }
}
