// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2, stdJson} from "forge-std/Script.sol";

import {HolancVerifier} from "../src/HolancVerifier.sol";

/// @notice Loads a snarkjs `*_vkey.json` file and stores it in HolancVerifier.
contract InitializeVerifierKey is Script {
    using stdJson for string;

    function run() external {
        uint256 ownerPrivateKey = vm.envUint("PRIVATE_KEY");
        address verifierAddress = _loadVerifierAddress();
        uint8 circuitType = uint8(vm.envUint("CIRCUIT_TYPE"));
        string memory vkeyPath = vm.envString("VKEY_PATH");
        string memory empty = "";
        string memory circuitLabel = vm.envOr("CIRCUIT_LABEL", empty);

        string memory json = vm.readFile(vkeyPath);
        uint256 nPublic = json.readUint(".nPublic");

        uint256[2] memory alpha = _readG1(json, ".vk_alpha_1");
        uint256[2][2] memory beta = _readG2(json, ".vk_beta_2");
        uint256[2][2] memory gamma = _readG2(json, ".vk_gamma_2");
        uint256[2][2] memory delta = _readG2(json, ".vk_delta_2");
        uint256[2][] memory ic = _readIc(json, nPublic + 1);

        vm.startBroadcast(ownerPrivateKey);
        HolancVerifier(verifierAddress).initializeVk(
            circuitType,
            alpha,
            beta,
            gamma,
            delta,
            ic
        );
        vm.stopBroadcast();

        console2.log("Verifier key initialized");
        console2.log("verifier", verifierAddress);
        console2.log("circuitType", uint256(circuitType));
        console2.log("circuitLabel", bytes(circuitLabel).length == 0 ? "(unset)" : circuitLabel);
        console2.log("vkeyPath", vkeyPath);
        console2.log("publicInputs", nPublic);
        console2.log("icPoints", ic.length);
    }

    function _loadVerifierAddress() internal view returns (address verifierAddress) {
        verifierAddress = vm.envOr("VERIFIER_ADDRESS", address(0));
        if (verifierAddress == address(0)) {
            verifierAddress = vm.envAddress("HOLANC_VERIFIER_ADDRESS");
        }
    }

    function _readG1(string memory json, string memory key) internal pure returns (uint256[2] memory point) {
        string[] memory raw = json.readStringArray(key);
        require(raw.length >= 2, "invalid G1 point");

        point[0] = vm.parseUint(raw[0]);
        point[1] = vm.parseUint(raw[1]);
    }

    function _readG2(string memory json, string memory key) internal pure returns (uint256[2][2] memory point) {
        string[] memory c0 = json.readStringArray(string.concat(key, "[0]"));
        string[] memory c1 = json.readStringArray(string.concat(key, "[1]"));
        require(c0.length >= 2 && c1.length >= 2, "invalid G2 point");

        point[0][0] = vm.parseUint(c0[0]);
        point[0][1] = vm.parseUint(c0[1]);
        point[1][0] = vm.parseUint(c1[0]);
        point[1][1] = vm.parseUint(c1[1]);
    }

    function _readIc(string memory json, uint256 length) internal pure returns (uint256[2][] memory ic) {
        ic = new uint256[2][](length);

        for (uint256 i = 0; i < length; i++) {
            string[] memory raw = json.readStringArray(string.concat(".IC[", vm.toString(i), "]"));
            require(raw.length >= 2, "invalid IC point");
            ic[i][0] = vm.parseUint(raw[0]);
            ic[i][1] = vm.parseUint(raw[1]);
        }
    }
}