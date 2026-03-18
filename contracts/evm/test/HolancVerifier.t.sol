// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {HolancVerifier} from "../src/HolancVerifier.sol";

contract HolancVerifierTest is Test {
    HolancVerifier verifier;
    address owner = address(this);

    function setUp() public {
        verifier = new HolancVerifier();
    }

    function test_initializeVk() public {
        uint256[2] memory alpha = [uint256(1), uint256(2)];
        uint256[2][2] memory beta = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2][2] memory gamma = [
            [uint256(7), uint256(8)],
            [uint256(9), uint256(10)]
        ];
        uint256[2][2] memory delta = [
            [uint256(11), uint256(12)],
            [uint256(13), uint256(14)]
        ];
        uint256[2][] memory ic = new uint256[2][](3);
        ic[0] = [uint256(15), uint256(16)];
        ic[1] = [uint256(17), uint256(18)];
        ic[2] = [uint256(19), uint256(20)];

        verifier.initializeVk(1, alpha, beta, gamma, delta, ic);
        assertTrue(verifier.vkInitialized(1));
    }

    function test_initializeVk_revert_duplicate() public {
        uint256[2] memory alpha = [uint256(1), uint256(2)];
        uint256[2][2] memory beta = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2][2] memory gamma = [
            [uint256(7), uint256(8)],
            [uint256(9), uint256(10)]
        ];
        uint256[2][2] memory delta = [
            [uint256(11), uint256(12)],
            [uint256(13), uint256(14)]
        ];
        uint256[2][] memory ic = new uint256[2][](2);
        ic[0] = [uint256(15), uint256(16)];
        ic[1] = [uint256(17), uint256(18)];

        verifier.initializeVk(1, alpha, beta, gamma, delta, ic);

        vm.expectRevert(HolancVerifier.VkAlreadyInitialized.selector);
        verifier.initializeVk(1, alpha, beta, gamma, delta, ic);
    }

    function test_initializeVk_revert_tooManyIc() public {
        uint256[2] memory alpha = [uint256(1), uint256(2)];
        uint256[2][2] memory beta = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2][2] memory gamma = [
            [uint256(7), uint256(8)],
            [uint256(9), uint256(10)]
        ];
        uint256[2][2] memory delta = [
            [uint256(11), uint256(12)],
            [uint256(13), uint256(14)]
        ];
        uint256[2][] memory ic = new uint256[2][](11); // exceeds MAX_PUBLIC_INPUTS + 1 = 9
        for (uint256 i = 0; i < 11; i++) {
            ic[i] = [uint256(i), uint256(i + 1)];
        }

        vm.expectRevert(HolancVerifier.TooManyIcPoints.selector);
        verifier.initializeVk(1, alpha, beta, gamma, delta, ic);
    }

    function test_initializeVk_onlyOwner() public {
        uint256[2] memory alpha = [uint256(1), uint256(2)];
        uint256[2][2] memory beta = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2][2] memory gamma = [
            [uint256(7), uint256(8)],
            [uint256(9), uint256(10)]
        ];
        uint256[2][2] memory delta = [
            [uint256(11), uint256(12)],
            [uint256(13), uint256(14)]
        ];
        uint256[2][] memory ic = new uint256[2][](2);
        ic[0] = [uint256(15), uint256(16)];
        ic[1] = [uint256(17), uint256(18)];

        vm.prank(address(0xdead));
        vm.expectRevert();
        verifier.initializeVk(1, alpha, beta, gamma, delta, ic);
    }

    function test_verifyProof_revert_noVk() public {
        uint256[2] memory a = [uint256(1), uint256(2)];
        uint256[2][2] memory b = [
            [uint256(3), uint256(4)],
            [uint256(5), uint256(6)]
        ];
        uint256[2] memory c = [uint256(7), uint256(8)];
        uint256[] memory inputs = new uint256[](1);
        inputs[0] = 42;

        vm.expectRevert(HolancVerifier.VkNotInitialized.selector);
        verifier.verifyProof(99, a, b, c, inputs);
    }
}
