// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";

/// An Inbox that refuses every message with its own error: it shows a refusal came before the Inbox
/// call, and that an Inbox failure after the vault paid rolls the whole bridge back.
contract TrapInbox {
    error InboxCalled();

    function sendL2Message(DataStructures.L2Actor calldata, bytes32, bytes32) external pure returns (bytes32, uint256) {
        revert InboxCalled();
    }
}
