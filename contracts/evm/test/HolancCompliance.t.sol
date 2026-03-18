// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HolancCompliance} from "../src/HolancCompliance.sol";
import {HolancVerifier} from "../src/HolancVerifier.sol";

contract HolancComplianceTest is Test {
    HolancCompliance compliance;
    HolancVerifier verifier;
    address owner = address(this);
    address pool = address(0x1);
    address oracle = address(0xAA);
    address user = address(0xBB);

    HolancCompliance.OraclePermissions fullPerms =
        HolancCompliance.OraclePermissions({
            canView: true,
            canRequestWealthProof: true,
            canFlag: true
        });

    function setUp() public {
        verifier = new HolancVerifier();
        compliance = new HolancCompliance();
        compliance.initialize(
            pool,
            address(verifier),
            HolancCompliance.ComplianceMode.OptionalDisclosure,
            86400
        );
    }

    function test_initialization() public view {
        assertEq(compliance.pool(), pool);
        assertEq(address(compliance.verifier()), address(verifier));
        assertTrue(compliance.isActive());
        assertEq(compliance.proofExpirySeconds(), 86400);
    }

    function test_initialize_revert_double() public {
        vm.expectRevert(HolancCompliance.AlreadyInitialized.selector);
        compliance.initialize(
            address(0x2),
            address(verifier),
            HolancCompliance.ComplianceMode.Permissionless,
            100
        );
    }

    function test_registerOracle() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);

        (
            address oraclePubkey,
            bytes32 name,
            HolancCompliance.OraclePermissions memory perms,
            int64 registeredAt,
            bool isActive,
            uint64 disclosureCount
        ) = compliance.oracles(oracle);

        assertEq(oraclePubkey, oracle);
        assertEq(name, keccak256("OracleName"));
        assertTrue(perms.canView);
        assertTrue(isActive);
        assertEq(disclosureCount, 0);
        assertGt(registeredAt, 0);
    }

    function test_registerOracle_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert();
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);
    }

    function test_deactivateOracle() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);
        compliance.deactivateOracle(oracle);

        (, , , , bool isActive, ) = compliance.oracles(oracle);
        assertFalse(isActive);
    }

    function test_discloseViewingKey() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);

        HolancCompliance.DisclosureScope memory scope = HolancCompliance
            .DisclosureScope({
                scopeType: HolancCompliance.DisclosureScopeType.Full,
                start: 0,
                end: 0,
                minAmount: 0
            });

        vm.prank(user);
        compliance.discloseViewingKey(oracle, "encrypted_vk_bytes", scope);

        assertEq(compliance.totalDisclosures(), 1);
    }

    function test_discloseViewingKey_revert_inactiveOracle() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);
        compliance.deactivateOracle(oracle);

        HolancCompliance.DisclosureScope memory scope = HolancCompliance
            .DisclosureScope({
                scopeType: HolancCompliance.DisclosureScopeType.Full,
                start: 0,
                end: 0,
                minAmount: 0
            });

        vm.prank(user);
        vm.expectRevert(HolancCompliance.OracleInactive.selector);
        compliance.discloseViewingKey(oracle, "enc_key", scope);
    }

    function test_discloseViewingKey_revert_noViewPermission() public {
        HolancCompliance.OraclePermissions memory noViewPerms = HolancCompliance
            .OraclePermissions({
                canView: false,
                canRequestWealthProof: false,
                canFlag: true
            });
        compliance.registerOracle(oracle, keccak256("OracleName"), noViewPerms);

        HolancCompliance.DisclosureScope memory scope = HolancCompliance
            .DisclosureScope({
                scopeType: HolancCompliance.DisclosureScopeType.Full,
                start: 0,
                end: 0,
                minAmount: 0
            });

        vm.prank(user);
        vm.expectRevert(HolancCompliance.OracleLacksPermission.selector);
        compliance.discloseViewingKey(oracle, "enc_key", scope);
    }

    function test_revokeDisclosure() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);

        HolancCompliance.DisclosureScope memory scope = HolancCompliance
            .DisclosureScope({
                scopeType: HolancCompliance.DisclosureScopeType.Full,
                start: 0,
                end: 0,
                minAmount: 0
            });

        vm.startPrank(user);
        compliance.discloseViewingKey(oracle, "enc_key", scope);
        compliance.revokeDisclosure(oracle);
        vm.stopPrank();
    }

    function test_revokeDisclosure_revert_notDiscloser() public {
        compliance.registerOracle(oracle, keccak256("OracleName"), fullPerms);

        HolancCompliance.DisclosureScope memory scope = HolancCompliance
            .DisclosureScope({
                scopeType: HolancCompliance.DisclosureScopeType.Full,
                start: 0,
                end: 0,
                minAmount: 0
            });

        vm.prank(user);
        compliance.discloseViewingKey(oracle, "enc_key", scope);

        vm.prank(address(0xC0FFEE));
        vm.expectRevert(HolancCompliance.NotDiscloser.selector);
        compliance.revokeDisclosure(oracle);
    }

    function test_updateProofExpiry() public {
        compliance.updateProofExpiry(3600);
        assertEq(compliance.proofExpirySeconds(), 3600);
    }

    function test_updateProofExpiry_revert_zero() public {
        vm.expectRevert(HolancCompliance.InvalidExpiry.selector);
        compliance.updateProofExpiry(0);
    }

    function test_submitWealthProof_revert_permissionless() public {
        HolancCompliance compPermissionless = new HolancCompliance();
        compPermissionless.initialize(
            pool,
            address(verifier),
            HolancCompliance.ComplianceMode.Permissionless,
            86400
        );

        uint256[2] memory a = [uint256(1), uint256(2)];
        uint256[2][2] memory b = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2] memory c = [uint256(7), uint256(8)];
        uint256[] memory inputs = new uint256[](1);
        inputs[0] = 100;

        vm.expectRevert(HolancCompliance.ComplianceModeDisallows.selector);
        compPermissionless.submitWealthProof(100, a, b, c, inputs);
    }
}
