// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";

/// Unit suite for the processor portal clone.
contract ProcessorPortalTest is Test {
    /// Our declaration must reach the real vault: `0x85afaff4` is `transact` in Privacy Pools v2's
    /// compiled PoolVault at the pinned commit.
    function test_vaultSelector_matchesThePool() public pure {
        assertEq(IPrivacyPoolVault.transact.selector, bytes4(0x85afaff4));
        assertEq(
            IPrivacyPoolVault.transact.selector,
            bytes4(keccak256("transact((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[])"))
        );
    }
}
