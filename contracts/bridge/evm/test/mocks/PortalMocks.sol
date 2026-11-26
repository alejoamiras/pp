// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TokenPortalImpl} from "../../src/TokenPortalImpl.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

/// The clone implementation with its pause checks deleted: the mutation canary that shows the pause
/// proofs' failure branches are reachable.
contract PortalImplWithoutPause is TokenPortalImpl {
    constructor(IRegistry registry, bytes32 l2Hub) TokenPortalImpl(registry, l2Hub) {}

    function _requireDeposit(uint256 amount) internal pure override {
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
    }

    function _requireWithdraw() internal view override {}
}
