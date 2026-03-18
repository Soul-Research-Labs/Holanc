// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

import {HolancBridge} from "../src/HolancBridge.sol";
import {HolancCompliance} from "../src/HolancCompliance.sol";
import {HolancNullifier} from "../src/HolancNullifier.sol";
import {HolancPool} from "../src/HolancPool.sol";
import {HolancVerifier} from "../src/HolancVerifier.sol";

/// @notice Deploys the full Holanc EVM stack and prints the resulting addresses
///         in a `.env`-friendly format.
contract DeployHolanc is Script {
    struct DeployConfig {
        address token;
        address feeCollector;
        address lzEndpoint;
        uint64 localChainId;
        uint64 localAppId;
        uint256 epochDurationBlocks;
        int64 proofExpirySeconds;
        HolancCompliance.ComplianceMode complianceMode;
    }

    function run() external returns (HolancVerifier verifier, HolancNullifier nullifier, HolancPool pool, HolancBridge bridge, HolancCompliance compliance) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        DeployConfig memory cfg = _loadConfig(deployer);

        vm.startBroadcast(deployerPrivateKey);

        verifier = new HolancVerifier();
        nullifier = new HolancNullifier();
        pool = new HolancPool(cfg.token, address(verifier), address(nullifier), cfg.feeCollector);
        bridge = new HolancBridge();
        compliance = new HolancCompliance();

        nullifier.initialize(address(pool), address(pool), cfg.epochDurationBlocks);
        bridge.initialize(address(pool), cfg.localChainId, cfg.localAppId, cfg.lzEndpoint);
        compliance.initialize(address(pool), address(verifier), cfg.complianceMode, cfg.proofExpirySeconds);
        pool.setBridge(address(bridge));

        vm.stopBroadcast();

        _printSummary(deployer, cfg, verifier, nullifier, pool, bridge, compliance);
    }

    function _loadConfig(address deployer) internal view returns (DeployConfig memory cfg) {
        cfg.token = vm.envAddress("TOKEN_ADDRESS");
        cfg.feeCollector = vm.envOr("FEE_COLLECTOR", deployer);
        cfg.lzEndpoint = vm.envOr("LZ_ENDPOINT", address(0));
        cfg.localChainId = uint64(vm.envOr("LOCAL_CHAIN_ID", uint256(block.chainid)));
        cfg.localAppId = uint64(vm.envOr("LOCAL_APP_ID", uint256(1)));
        cfg.epochDurationBlocks = vm.envOr("EPOCH_DURATION_BLOCKS", uint256(7200));
        cfg.proofExpirySeconds = int64(int256(vm.envOr("PROOF_EXPIRY_SECONDS", uint256(86400))));

        uint256 complianceModeRaw = vm.envOr("COMPLIANCE_MODE", uint256(1));
        require(complianceModeRaw <= uint256(type(HolancCompliance.ComplianceMode).max), "invalid COMPLIANCE_MODE");
        cfg.complianceMode = HolancCompliance.ComplianceMode(complianceModeRaw);
    }

    function _printSummary(
        address deployer,
        DeployConfig memory cfg,
        HolancVerifier verifier,
        HolancNullifier nullifier,
        HolancPool pool,
        HolancBridge bridge,
        HolancCompliance compliance
    ) internal view {
        console2.log("Holanc EVM deployment complete");
        console2.log("deployer", deployer);
        console2.log("chainId", block.chainid);
        console2.log("token", cfg.token);
        console2.log("feeCollector", cfg.feeCollector);
        console2.log("lzEndpoint", cfg.lzEndpoint);
        console2.log("localChainId", cfg.localChainId);
        console2.log("localAppId", cfg.localAppId);
        console2.log("epochDurationBlocks", cfg.epochDurationBlocks);
        console2.log("proofExpirySeconds", uint256(uint64(cfg.proofExpirySeconds)));

        console2.log("HOLANC_VERIFIER_ADDRESS=%s", address(verifier));
        console2.log("HOLANC_NULLIFIER_ADDRESS=%s", address(nullifier));
        console2.log("HOLANC_POOL_ADDRESS=%s", address(pool));
        console2.log("HOLANC_BRIDGE_ADDRESS=%s", address(bridge));
        console2.log("HOLANC_COMPLIANCE_ADDRESS=%s", address(compliance));
    }
}