// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HolancBridge} from "../src/HolancBridge.sol";

contract HolancBridgeTest is Test {
    HolancBridge bridge;
    address owner = address(this);
    address pool = address(0x1);

    uint64 LOCAL_CHAIN = 1;
    uint64 REMOTE_CHAIN = 2;
    uint64 LOCAL_APP = 100;

    function setUp() public {
        bridge = new HolancBridge();
        bridge.initialize(pool, LOCAL_CHAIN, LOCAL_APP, address(0));
        bridge.setTrustedPeer(REMOTE_CHAIN, keccak256("remote_peer"));
    }

    function test_initialization() public view {
        assertEq(bridge.pool(), pool);
        assertEq(bridge.localChainId(), LOCAL_CHAIN);
        assertEq(bridge.localAppId(), LOCAL_APP);
        assertTrue(bridge.isActive());
    }

    function test_initialize_revert_double() public {
        vm.expectRevert(HolancBridge.AlreadyInitialized.selector);
        bridge.initialize(address(0x2), 2, 200, address(0));
    }

    function test_publishEpochRoot() public {
        bytes32 root = keccak256("epoch_nullifier_root");
        bridge.publishEpochRoot(0, root, 42);

        (
            uint64 sourceChain,
            uint64 sourceApp,
            uint64 epoch,
            bytes32 stored,
            ,
            ,

        ) = bridge.outboundMessages(0);
        assertEq(sourceChain, LOCAL_CHAIN);
        assertEq(sourceApp, LOCAL_APP);
        assertEq(epoch, 0);
        assertEq(stored, root);
        assertEq(bridge.epochCounter(), 1);
    }

    function test_publishEpochRoot_revert_inactive() public {
        bridge.setActive(false);
        vm.expectRevert(HolancBridge.BridgeInactive.selector);
        bridge.publishEpochRoot(0, keccak256("root"), 0);
    }

    function test_receiveEpochRoot() public {
        bytes32 nullifierRoot = keccak256("foreign_root");
        bytes32 messageHash = sha256(
            abi.encodePacked(REMOTE_CHAIN, uint64(5), nullifierRoot, uint64(10))
        );

        bridge.receiveEpochRoot(
            REMOTE_CHAIN,
            5,
            nullifierRoot,
            10,
            messageHash
        );

        (
            uint64 sourceChain,
            uint64 epoch,
            bytes32 stored,
            uint64 count,
            bytes32 hash,
            int64 receivedAt
        ) = bridge.foreignRoots(REMOTE_CHAIN, 5);
        assertEq(sourceChain, REMOTE_CHAIN);
        assertEq(epoch, 5);
        assertEq(stored, nullifierRoot);
        assertEq(count, 10);
        assertEq(hash, messageHash);
        assertGt(receivedAt, 0);
    }

    function test_receiveEpochRoot_revert_ownChain() public {
        bytes32 root = keccak256("root");
        bytes32 hash = sha256(
            abi.encodePacked(LOCAL_CHAIN, uint64(0), root, uint64(0))
        );
        vm.expectRevert(HolancBridge.CannotReceiveOwnChain.selector);
        bridge.receiveEpochRoot(LOCAL_CHAIN, 0, root, 0, hash);
    }

    function test_receiveEpochRoot_revert_badHash() public {
        bytes32 root = keccak256("root");
        bytes32 wrong = keccak256("wrong_hash");
        vm.expectRevert(HolancBridge.InvalidMerkleProof.selector);
        bridge.receiveEpochRoot(REMOTE_CHAIN, 0, root, 0, wrong);
    }

    function test_lockCommitment() public {
        bytes32 commitment = keccak256("commitment_1");
        bridge.lockCommitment(commitment, REMOTE_CHAIN, "proof_data");

        assertTrue(bridge.isCommitmentLocked(commitment));
    }

    function test_lockCommitment_revert_duplicate() public {
        bytes32 commitment = keccak256("commitment_2");
        bridge.lockCommitment(commitment, REMOTE_CHAIN, "proof");
        vm.expectRevert(HolancBridge.CommitmentAlreadyLocked.selector);
        bridge.lockCommitment(commitment, REMOTE_CHAIN, "proof2");
    }

    function test_lockCommitment_revert_selfBridge() public {
        vm.expectRevert(HolancBridge.CannotBridgeToSelf.selector);
        bridge.lockCommitment(keccak256("c"), LOCAL_CHAIN, "proof");
    }

    function test_isCommitmentLocked_false() public view {
        assertFalse(bridge.isCommitmentLocked(keccak256("nonexistent")));
    }

    function test_setActive_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert();
        bridge.setActive(false);
    }

    function test_verifyForeignNullifier_noRoot() public view {
        bytes32[] memory path = new bytes32[](0);
        uint8[] memory indices = new uint8[](0);
        assertFalse(
            bridge.verifyForeignNullifier(
                REMOTE_CHAIN,
                99,
                keccak256("nf"),
                path,
                indices
            )
        );
    }
}
