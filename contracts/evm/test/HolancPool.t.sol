// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HolancPool} from "../src/HolancPool.sol";
import {HolancVerifier} from "../src/HolancVerifier.sol";
import {HolancNullifier} from "../src/HolancNullifier.sol";

/// @dev Minimal ERC-20 for testing.
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract HolancPoolTest is Test {
    HolancPool pool;
    HolancVerifier verifier;
    HolancNullifier nullifier;
    MockToken token;
    address owner = address(this);
    address feeCollector = address(0xFEE);
    address depositor = address(0xD);

    function setUp() public {
        token = new MockToken();
        verifier = new HolancVerifier();
        nullifier = new HolancNullifier();

        pool = new HolancPool(
            address(token),
            address(verifier),
            address(nullifier),
            feeCollector
        );

        // Initialize nullifier with pool as registrar
        nullifier.initialize(address(pool), address(pool), 7200);

        // Fund depositor
        token.transfer(depositor, 100 ether);
    }

    function test_deployment() public view {
        assertEq(address(pool.token()), address(token));
        assertEq(address(pool.verifier()), address(verifier));
        assertEq(address(pool.nullifier()), address(nullifier));
        assertEq(pool.feeCollector(), feeCollector);
        assertEq(pool.nextLeafIndex(), 0);
        assertFalse(pool.isPaused());
    }

    function test_deposit() public {
        bytes32 commitment = keccak256("note_1");
        uint256 amount = 1 ether;

        vm.startPrank(depositor);
        token.approve(address(pool), amount);
        pool.deposit(amount, commitment, "encrypted_data");
        vm.stopPrank();

        assertEq(pool.nextLeafIndex(), 1);
        assertEq(pool.totalDeposited(), amount);
        assertEq(pool.lastCommitment(), commitment);
        assertEq(token.balanceOf(address(pool)), amount);
    }

    function test_deposit_multiple() public {
        vm.startPrank(depositor);
        token.approve(address(pool), 10 ether);

        pool.deposit(1 ether, keccak256("note_1"), "enc1");
        pool.deposit(2 ether, keccak256("note_2"), "enc2");
        pool.deposit(3 ether, keccak256("note_3"), "enc3");
        vm.stopPrank();

        assertEq(pool.nextLeafIndex(), 3);
        assertEq(pool.totalDeposited(), 6 ether);
        assertEq(token.balanceOf(address(pool)), 6 ether);
    }

    function test_deposit_revert_paused() public {
        pool.setPaused(true);

        vm.startPrank(depositor);
        token.approve(address(pool), 1 ether);
        vm.expectRevert(HolancPool.PoolPaused.selector);
        pool.deposit(1 ether, keccak256("note"), "enc");
        vm.stopPrank();
    }

    function test_deposit_revert_zeroAmount() public {
        vm.startPrank(depositor);
        vm.expectRevert(HolancPool.ZeroAmount.selector);
        pool.deposit(0, keccak256("note"), "enc");
        vm.stopPrank();
    }

    function test_deposit_revert_noteTooLarge() public {
        bytes memory bigNote = new bytes(257);
        vm.startPrank(depositor);
        token.approve(address(pool), 1 ether);
        vm.expectRevert(HolancPool.EncryptedNoteTooLarge.selector);
        pool.deposit(1 ether, keccak256("note"), bigNote);
        vm.stopPrank();
    }

    function test_setPaused_onlyOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert();
        pool.setPaused(true);
    }

    function test_setBridge() public {
        pool.setBridge(address(0xBB));
        assertEq(pool.bridge(), address(0xBB));
    }

    function test_setFeeCollector() public {
        pool.setFeeCollector(address(0xABC));
        assertEq(pool.feeCollector(), address(0xABC));
    }

    function test_updateRoot() public {
        // First deposit to set sha256Root
        vm.startPrank(depositor);
        token.approve(address(pool), 1 ether);
        pool.deposit(1 ether, keccak256("note_1"), "enc");
        vm.stopPrank();

        bytes32 sha256Root = pool.sha256Root();
        bytes32 newRoot = keccak256("poseidon_root");

        pool.updateRoot(newRoot, sha256Root);
        assertEq(pool.currentRoot(), newRoot);
    }

    function test_updateRoot_revert_integrityMismatch() public {
        bytes32 wrongSha256Root = keccak256("wrong");
        bytes32 newRoot = keccak256("poseidon_root");

        vm.expectRevert(HolancPool.RootIntegrityMismatch.selector);
        pool.updateRoot(newRoot, wrongSha256Root);
    }

    function test_sha256MerkleTree_consistency() public {
        // Deposit 4 notes and verify the SHA-256 root changes each time
        bytes32 prevRoot;

        vm.startPrank(depositor);
        token.approve(address(pool), 10 ether);

        for (uint256 i = 0; i < 4; i++) {
            bytes32 commitment = keccak256(abi.encodePacked("note_", i));
            pool.deposit(1 ether, commitment, "enc");
            bytes32 newShaRoot = pool.sha256Root();
            assertTrue(newShaRoot != prevRoot, "SHA-256 root should change");
            prevRoot = newShaRoot;
        }
        vm.stopPrank();
    }
}
