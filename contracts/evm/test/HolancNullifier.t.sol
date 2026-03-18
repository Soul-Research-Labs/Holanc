// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HolancNullifier} from "../src/HolancNullifier.sol";

contract HolancNullifierTest is Test {
    HolancNullifier nullifier;
    address owner = address(this);
    address pool = address(0x1);
    address registrar = address(0x2);

    function setUp() public {
        nullifier = new HolancNullifier();
        nullifier.initialize(pool, registrar, 7200);
    }

    function test_initialize() public view {
        assertEq(nullifier.pool(), pool);
        assertEq(nullifier.registrar(), registrar);
        assertEq(nullifier.epochDurationBlocks(), 7200);
        assertEq(nullifier.currentEpoch(), 0);
    }

    function test_initialize_revert_double() public {
        vm.expectRevert(HolancNullifier.AlreadyInitialized.selector);
        nullifier.initialize(address(0x3), address(0x4), 100);
    }

    function test_registerNullifier() public {
        bytes32 nf = keccak256("nullifier_1");
        vm.prank(registrar);
        nullifier.registerNullifier(0, nf);

        assertTrue(nullifier.isNullifierSpent(0, nf));
        assertEq(nullifier.totalNullifiers(), 1);
    }

    function test_registerNullifier_revert_unauthorized() public {
        bytes32 nf = keccak256("nullifier_2");
        vm.prank(address(0xdead));
        vm.expectRevert(HolancNullifier.Unauthorized.selector);
        nullifier.registerNullifier(0, nf);
    }

    function test_registerNullifier_revert_doubleSpend() public {
        bytes32 nf = keccak256("nullifier_3");
        vm.prank(registrar);
        nullifier.registerNullifier(0, nf);

        vm.prank(registrar);
        vm.expectRevert(HolancNullifier.NullifierAlreadySpent.selector);
        nullifier.registerNullifier(0, nf);
    }

    function test_registerNullifierV2_domainSeparation() public {
        bytes32 nf = keccak256("nullifier_v2");
        uint64 chainId = 1;
        uint64 appId = 100;

        vm.prank(registrar);
        nullifier.registerNullifierV2(0, nf, chainId, appId);

        // The V2 and V1 nullifiers map to different bitmap slots,
        // so registering the same nullifier via V1 should succeed.
        vm.prank(registrar);
        nullifier.registerNullifier(0, nf); // different hash → different slot

        assertEq(nullifier.totalNullifiers(), 2);
    }

    function test_isNullifierSpent_uninitialized() public view {
        bytes32 nf = keccak256("never_registered");
        assertFalse(nullifier.isNullifierSpent(99, nf));
    }

    function test_finalizeEpoch() public {
        bytes32 root = keccak256("epoch_root");
        nullifier.finalizeEpoch(root);

        (
            bytes32 storedRoot,
            uint256 finalizedBlock,
            uint64 nullifierCount
        ) = nullifier.epochRecords(0);
        assertEq(storedRoot, root);
        assertGt(finalizedBlock, 0);
        assertEq(nullifierCount, 0);
        assertEq(nullifier.currentEpoch(), 1);
    }

    function test_finalizeEpoch_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert();
        nullifier.finalizeEpoch(keccak256("root"));
    }
}
