// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HolancVerifier — On-chain Groth16 proof verifier for Holanc circuits.
/// @notice Ports the Solana holanc-verifier program to EVM using BN254 precompiles.
/// @dev Uses ecAdd (0x06), ecMul (0x07), ecPairing (0x08) precompiled contracts.
contract HolancVerifier is Ownable {
    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// BN254 base field prime q (for G1 point negation).
    uint256 internal constant BN254_Q =
        0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47;

    /// Maximum number of public inputs supported per circuit.
    uint256 internal constant MAX_PUBLIC_INPUTS = 8;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    struct VerificationKey {
        uint256[2] alpha; // G1 point
        uint256[2][2] beta; // G2 point
        uint256[2][2] gamma; // G2 point
        uint256[2][2] delta; // G2 point
        uint256[2][] ic; // IC points (length = numInputs + 1)
    }

    /// Circuit type → verification key.
    mapping(uint8 => VerificationKey) internal _vks;

    /// Whether a verification key has been set for a circuit type.
    mapping(uint8 => bool) public vkInitialized;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event VkInitialized(uint8 indexed circuitType);
    event ProofVerified(uint8 indexed circuitType, address indexed verifier);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error VkAlreadyInitialized();
    error VkNotInitialized();
    error TooManyIcPoints();
    error PublicInputCountMismatch();
    error EcAddFailed();
    error EcMulFailed();
    error PairingFailed();
    error ProofVerificationFailed();

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    constructor() Ownable(msg.sender) {}

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Store a Groth16 verification key for a circuit type.
    /// @param circuitType Unique identifier for the circuit.
    /// @param alpha G1 point (α).
    /// @param beta G2 point (β).
    /// @param gamma G2 point (γ).
    /// @param delta G2 point (δ).
    /// @param ic Array of IC G1 points (length = numPublicInputs + 1).
    function initializeVk(
        uint8 circuitType,
        uint256[2] calldata alpha,
        uint256[2][2] calldata beta,
        uint256[2][2] calldata gamma,
        uint256[2][2] calldata delta,
        uint256[2][] calldata ic
    ) external onlyOwner {
        if (vkInitialized[circuitType]) revert VkAlreadyInitialized();
        if (ic.length > MAX_PUBLIC_INPUTS + 1) revert TooManyIcPoints();

        VerificationKey storage vk = _vks[circuitType];
        vk.alpha = alpha;
        vk.beta = beta;
        vk.gamma = gamma;
        vk.delta = delta;

        // Copy IC points
        for (uint256 i = 0; i < ic.length; i++) {
            vk.ic.push(ic[i]);
        }

        vkInitialized[circuitType] = true;
        emit VkInitialized(circuitType);
    }

    // -----------------------------------------------------------------------
    // Verification
    // -----------------------------------------------------------------------

    /// @notice Verify a Groth16 proof.
    /// @param circuitType The circuit type (selects the verification key).
    /// @param a Proof element π_A (G1 point).
    /// @param b Proof element π_B (G2 point).
    /// @param c Proof element π_C (G1 point).
    /// @param publicInputs Array of public inputs (field elements).
    /// @return True if the proof is valid.
    function verifyProof(
        uint8 circuitType,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs
    ) external returns (bool) {
        if (!vkInitialized[circuitType]) revert VkNotInitialized();

        VerificationKey storage vk = _vks[circuitType];

        if (publicInputs.length + 1 != vk.ic.length) {
            revert PublicInputCountMismatch();
        }

        // Step 1: Compute vk_x = IC[0] + Σ(publicInput[i] · IC[i+1])
        uint256[2] memory vkX = vk.ic[0];

        for (uint256 i = 0; i < publicInputs.length; i++) {
            uint256[2] memory mulResult = _ecMul(vk.ic[i + 1], publicInputs[i]);
            vkX = _ecAdd(vkX, mulResult);
        }

        // Step 2: Negate π_A
        uint256[2] memory negA = _negateG1(a);

        // Step 3: Pairing check
        // e(-π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) == 1
        bool success = _pairingCheck(
            negA,
            b,
            vk.alpha,
            vk.beta,
            vkX,
            vk.gamma,
            c,
            vk.delta
        );

        if (!success) revert ProofVerificationFailed();

        emit ProofVerified(circuitType, msg.sender);
        return true;
    }

    /// @notice View-only proof verification (does not emit events).
    function verifyProofStatic(
        uint8 circuitType,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[] calldata publicInputs
    ) external view returns (bool) {
        if (!vkInitialized[circuitType]) revert VkNotInitialized();

        VerificationKey storage vk = _vks[circuitType];

        if (publicInputs.length + 1 != vk.ic.length) {
            revert PublicInputCountMismatch();
        }

        uint256[2] memory vkX = vk.ic[0];
        for (uint256 i = 0; i < publicInputs.length; i++) {
            uint256[2] memory mulResult = _ecMul(vk.ic[i + 1], publicInputs[i]);
            vkX = _ecAdd(vkX, mulResult);
        }

        uint256[2] memory negA = _negateG1(a);
        return
            _pairingCheck(
                negA,
                b,
                vk.alpha,
                vk.beta,
                vkX,
                vk.gamma,
                c,
                vk.delta
            );
    }

    // -----------------------------------------------------------------------
    // BN254 Precompile Wrappers
    // -----------------------------------------------------------------------

    /// @dev ecAdd: G1 point addition via precompile at address 0x06.
    function _ecAdd(
        uint256[2] memory p1,
        uint256[2] memory p2
    ) internal view returns (uint256[2] memory result) {
        uint256[4] memory input;
        input[0] = p1[0];
        input[1] = p1[1];
        input[2] = p2[0];
        input[3] = p2[1];

        bool success;
        assembly {
            success := staticcall(gas(), 0x06, input, 0x80, result, 0x40)
        }
        if (!success) revert EcAddFailed();
    }

    /// @dev ecMul: G1 scalar multiplication via precompile at address 0x07.
    function _ecMul(
        uint256[2] memory point,
        uint256 scalar
    ) internal view returns (uint256[2] memory result) {
        uint256[3] memory input;
        input[0] = point[0];
        input[1] = point[1];
        input[2] = scalar;

        bool success;
        assembly {
            success := staticcall(gas(), 0x07, input, 0x60, result, 0x40)
        }
        if (!success) revert EcMulFailed();
    }

    /// @dev Negate a G1 point: (x, y) → (x, q - y).
    function _negateG1(
        uint256[2] calldata point
    ) internal pure returns (uint256[2] memory) {
        if (point[0] == 0 && point[1] == 0) {
            return [uint256(0), uint256(0)];
        }
        return [point[0], BN254_Q - (point[1] % BN254_Q)];
    }

    /// @dev ecPairing: BN254 pairing check via precompile at address 0x08.
    ///      Checks: e(a1, b1) · e(a2, b2) · e(a3, b3) · e(a4, b4) == 1
    function _pairingCheck(
        uint256[2] memory a1,
        uint256[2][2] memory b1,
        uint256[2] memory a2,
        uint256[2][2] memory b2,
        uint256[2] memory a3,
        uint256[2][2] memory b3,
        uint256[2] memory a4,
        uint256[2][2] memory b4
    ) internal view returns (bool) {
        // Pairing precompile input: 4 pairs × (G1=2×32 + G2=4×32) = 4 × 192 = 768 bytes
        uint256[24] memory input;
        // Pair 1: (a1, b1)
        input[0] = a1[0];
        input[1] = a1[1];
        // G2 points are encoded as: (x_im, x_re, y_im, y_re)
        input[2] = b1[0][0];
        input[3] = b1[0][1];
        input[4] = b1[1][0];
        input[5] = b1[1][1];

        // Pair 2: (a2, b2)
        input[6] = a2[0];
        input[7] = a2[1];
        input[8] = b2[0][0];
        input[9] = b2[0][1];
        input[10] = b2[1][0];
        input[11] = b2[1][1];

        // Pair 3: (a3, b3)
        input[12] = a3[0];
        input[13] = a3[1];
        input[14] = b3[0][0];
        input[15] = b3[0][1];
        input[16] = b3[1][0];
        input[17] = b3[1][1];

        // Pair 4: (a4, b4)
        input[18] = a4[0];
        input[19] = a4[1];
        input[20] = b4[0][0];
        input[21] = b4[0][1];
        input[22] = b4[1][0];
        input[23] = b4[1][1];

        uint256[1] memory result;
        bool success;
        assembly {
            success := staticcall(gas(), 0x08, input, 0x300, result, 0x20)
        }
        if (!success) revert PairingFailed();
        return result[0] == 1;
    }
}
