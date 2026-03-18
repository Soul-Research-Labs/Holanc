// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HolancVerifier} from "./HolancVerifier.sol";

/// @title HolancCompliance — Selective transparency & wealth proof attestation.
/// @notice Ports the Solana holanc-compliance program to EVM. Supports oracle
///         registration, viewing key disclosure, and ZK wealth proof verification.
contract HolancCompliance is Ownable {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Maximum registered compliance oracles.
    uint256 public constant MAX_ORACLES = 16;

    /// Circuit type for wealth proofs (must match verifier VK).
    uint8 public constant CIRCUIT_WEALTH_PROOF = 10;

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    enum ComplianceMode {
        Permissionless, // No compliance hooks
        OptionalDisclosure, // Users can choose to share viewing keys
        MandatoryDisclosure // Deposits require oracle attestation
    }

    struct OraclePermissions {
        bool canView;
        bool canRequestWealthProof;
        bool canFlag;
    }

    enum DisclosureScopeType {
        Full,
        TimeBounded,
        AmountBounded
    }

    struct DisclosureScope {
        DisclosureScopeType scopeType;
        int64 start; // For TimeBounded
        int64 end; // For TimeBounded
        uint64 minAmount; // For AmountBounded
    }

    struct OracleRecord {
        address oraclePubkey;
        bytes32 oracleName;
        OraclePermissions permissions;
        int64 registeredAt;
        bool isActive;
        uint64 disclosureCount;
    }

    struct DisclosureRecord {
        address discloser;
        address oracle;
        bytes encryptedViewingKey;
        DisclosureScope scope;
        int64 disclosedAt;
        bool isRevoked;
        int64 revokedAt;
    }

    struct WealthAttestation {
        address prover;
        uint64 threshold;
        bytes32 proofHash;
        uint8 circuitType;
        int64 attestedAt;
        bool isValid;
        int64 expiry;
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// Pool this compliance config serves.
    address public pool;

    /// Compliance mode.
    ComplianceMode public mode;

    /// Number of registered oracles.
    uint8 public oracleCount;

    /// Total disclosures made.
    uint64 public totalDisclosures;

    /// Whether compliance is active.
    bool public isActive;

    /// Proof expiry in seconds.
    int64 public proofExpirySeconds;

    /// Verifier contract reference.
    HolancVerifier public verifier;

    /// Oracle pubkey → OracleRecord.
    mapping(address => OracleRecord) public oracles;

    /// keccak256(discloser, oracle) → DisclosureRecord.
    mapping(bytes32 => DisclosureRecord) internal _disclosures;

    /// keccak256(pool, prover) → WealthAttestation.
    mapping(bytes32 => WealthAttestation) internal _attestations;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event OracleRegistered(
        address indexed pool,
        address indexed oracle,
        OraclePermissions permissions
    );
    event ViewingKeyDisclosed(
        address indexed pool,
        address indexed discloser,
        address indexed oracle,
        DisclosureScope scope
    );
    event DisclosureRevoked(
        address indexed pool,
        address indexed discloser,
        address indexed oracle
    );
    event WealthProofSubmitted(
        address indexed pool,
        address indexed prover,
        uint64 threshold,
        uint8 circuitType
    );
    event WealthProofInvalidated(address indexed pool, address indexed prover);
    event WealthProofValidated(
        address indexed pool,
        address indexed prover,
        uint64 threshold
    );
    event OracleDeactivated(address indexed pool, address indexed oracle);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error Unauthorized();
    error TooManyOracles();
    error OracleInactive();
    error NotDiscloser();
    error AlreadyRevoked();
    error ThresholdMismatch();
    error OracleLacksPermission();
    error ComplianceModeDisallows();
    error ProofInvalidated();
    error ProofExpired();
    error InvalidExpiry();
    error AlreadyInitialized();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /// @notice Initialize the compliance configuration.
    /// @param _pool               The pool contract address.
    /// @param _verifier           The verifier contract address.
    /// @param _mode               Compliance mode.
    /// @param _proofExpirySeconds Proof validity duration in seconds.
    function initialize(
        address _pool,
        address _verifier,
        ComplianceMode _mode,
        int64 _proofExpirySeconds
    ) external onlyOwner {
        if (pool != address(0)) revert AlreadyInitialized();
        pool = _pool;
        verifier = HolancVerifier(_verifier);
        mode = _mode;
        proofExpirySeconds = _proofExpirySeconds > 0
            ? _proofExpirySeconds
            : int64(86400);
        isActive = true;
    }

    // -----------------------------------------------------------------------
    // Oracle Management
    // -----------------------------------------------------------------------

    /// @notice Register a compliance oracle.
    function registerOracle(
        address oraclePubkey,
        bytes32 oracleName,
        OraclePermissions calldata permissions
    ) external onlyOwner {
        if (oracleCount >= MAX_ORACLES) revert TooManyOracles();

        oracles[oraclePubkey] = OracleRecord({
            oraclePubkey: oraclePubkey,
            oracleName: oracleName,
            permissions: permissions,
            registeredAt: int64(int256(block.timestamp)),
            isActive: true,
            disclosureCount: 0
        });

        oracleCount++;
        emit OracleRegistered(pool, oraclePubkey, permissions);
    }

    /// @notice Deactivate an oracle.
    function deactivateOracle(address oraclePubkey) external onlyOwner {
        oracles[oraclePubkey].isActive = false;
        emit OracleDeactivated(pool, oraclePubkey);
    }

    // -----------------------------------------------------------------------
    // Viewing Key Disclosure
    // -----------------------------------------------------------------------

    /// @notice Disclose a viewing key to a registered oracle.
    /// @param oracle               The oracle address.
    /// @param encryptedViewingKey   Viewing key encrypted with the oracle's public key.
    /// @param scope                 Scope of the disclosure.
    function discloseViewingKey(
        address oracle,
        bytes calldata encryptedViewingKey,
        DisclosureScope calldata scope
    ) external {
        OracleRecord storage oracleRec = oracles[oracle];
        if (!oracleRec.isActive) revert OracleInactive();
        if (!oracleRec.permissions.canView) revert OracleLacksPermission();

        bytes32 key = keccak256(abi.encodePacked(msg.sender, oracle));
        _disclosures[key] = DisclosureRecord({
            discloser: msg.sender,
            oracle: oracle,
            encryptedViewingKey: encryptedViewingKey,
            scope: scope,
            disclosedAt: int64(int256(block.timestamp)),
            isRevoked: false,
            revokedAt: 0
        });

        totalDisclosures++;
        oracleRec.disclosureCount++;

        emit ViewingKeyDisclosed(pool, msg.sender, oracle, scope);
    }

    /// @notice Revoke a previous viewing key disclosure.
    /// @param oracle The oracle to revoke the disclosure from.
    function revokeDisclosure(address oracle) external {
        bytes32 key = keccak256(abi.encodePacked(msg.sender, oracle));
        DisclosureRecord storage disclosure = _disclosures[key];

        if (disclosure.discloser != msg.sender) revert NotDiscloser();
        if (disclosure.isRevoked) revert AlreadyRevoked();

        disclosure.isRevoked = true;
        disclosure.revokedAt = int64(int256(block.timestamp));

        emit DisclosureRevoked(pool, msg.sender, oracle);
    }

    // -----------------------------------------------------------------------
    // Wealth Proof
    // -----------------------------------------------------------------------

    /// @notice Submit a ZK wealth proof attestation.
    /// @param threshold    Minimum balance to prove ("my balance >= threshold").
    /// @param proofA       Groth16 proof element π_A.
    /// @param proofB       Groth16 proof element π_B.
    /// @param proofC       Groth16 proof element π_C.
    /// @param publicInputs Public inputs for the wealth proof circuit.
    function submitWealthProof(
        uint64 threshold,
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256[] calldata publicInputs
    ) external {
        if (mode == ComplianceMode.Permissionless)
            revert ComplianceModeDisallows();

        // Verify the ZK proof via the verifier contract
        verifier.verifyProof(
            CIRCUIT_WEALTH_PROOF,
            proofA,
            proofB,
            proofC,
            publicInputs
        );

        // First public input must encode the threshold
        if (publicInputs.length > 0 && publicInputs[0] != uint256(threshold)) {
            revert ThresholdMismatch();
        }

        bytes32 proofHash = sha256(
            abi.encodePacked(
                proofA[0],
                proofA[1],
                proofB[0][0],
                proofB[0][1],
                proofB[1][0],
                proofB[1][1],
                proofC[0],
                proofC[1]
            )
        );
        bytes32 key = keccak256(abi.encodePacked(pool, msg.sender));

        _attestations[key] = WealthAttestation({
            prover: msg.sender,
            threshold: threshold,
            proofHash: proofHash,
            circuitType: CIRCUIT_WEALTH_PROOF,
            attestedAt: int64(int256(block.timestamp)),
            isValid: true,
            expiry: int64(int256(block.timestamp)) + proofExpirySeconds
        });

        emit WealthProofSubmitted(
            pool,
            msg.sender,
            threshold,
            CIRCUIT_WEALTH_PROOF
        );
    }

    /// @notice Invalidate an expired or contested wealth proof.
    /// @param prover The address whose wealth proof to invalidate.
    function invalidateWealthProof(address prover) external {
        bytes32 key = keccak256(abi.encodePacked(pool, prover));
        WealthAttestation storage att = _attestations[key];

        bool isProver = prover == msg.sender;
        bool isAdmin = owner() == msg.sender;
        bool isExpired = int64(int256(block.timestamp)) > att.expiry;

        if (!isProver && !isAdmin && !isExpired) revert Unauthorized();

        att.isValid = false;
        emit WealthProofInvalidated(pool, prover);
    }

    /// @notice Validate whether a wealth attestation is still valid.
    /// @param prover The prover to check.
    /// @return threshold The proven minimum balance.
    function validateWealthProof(
        address prover
    ) external returns (uint64 threshold) {
        bytes32 key = keccak256(abi.encodePacked(pool, prover));
        WealthAttestation storage att = _attestations[key];

        if (!att.isValid) revert ProofInvalidated();
        if (int64(int256(block.timestamp)) > att.expiry) revert ProofExpired();

        emit WealthProofValidated(pool, prover, att.threshold);
        return att.threshold;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Update the proof expiry duration.
    function updateProofExpiry(int64 _proofExpirySeconds) external onlyOwner {
        if (_proofExpirySeconds <= 0) revert InvalidExpiry();
        proofExpirySeconds = _proofExpirySeconds;
    }
}
