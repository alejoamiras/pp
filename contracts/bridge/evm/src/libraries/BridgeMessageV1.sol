// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

/// @title BridgeMessageV1
/// @notice The v1 bridge payloads: 32-byte big-endian words, hashed with Aztec's `sha256ToField`.
/// The TS package bridge-spec is the reference; `test/BridgeMessageV1.t.sol` checks this library against
/// its generated vectors, and Noir's `bridge_message` is checked against the same file.
/// @dev Each preimage builder carries every width check and each `*Content` only hashes its
/// preimage, so a harness that replaces the hash keeps every check. Error names equal the TS
/// `SpecRangeError.code` and the Noir assert messages. `payee != portal` is the caller's check.
library BridgeMessageV1 {
    /// Tags are ASCII read as big-endian integers (< 2^248, so also fields); never `bytes32("…")`.
    bytes32 internal constant PP_BRIDGE_DATA_V1 = 0x00000000000000000000000000000070702e6272696467652e646174612e7631;
    bytes32 internal constant PP_BRIDGE_IN_V1 = 0x000000000000000000000000000000000070702e6272696467652e696e2e7631;
    bytes32 internal constant PP_BRIDGE_OUT_V1 = 0x0000000000000000000000000000000070702e6272696467652e6f75742e7631;
    bytes32 internal constant PP_BRIDGE_RAGEQUIT_V1 = 0x000000000000000000000070702e6272696467652e72616765717569742e7631;

    /// BN254 scalar field modulus: every word must be below it to exist on Aztec.
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error SecretHashOutOfRange(bytes32 secretHash);
    error FieldOutOfRange(uint256 value);
    error AmountOutOfRange(uint256 amount);
    error ZeroPayee();
    error LabelOutOfRange(uint256 label);

    /// @notice `TransactParams.data` of a bridge: `abi.encode(PP_BRIDGE_DATA_V1, secretHash)`, 64 bytes.
    /// @dev Reverts `SecretHashOutOfRange` unless `0 < secretHash < P`.
    function bridgeData(bytes32 secretHash) internal pure returns (bytes memory) {
        if (secretHash == 0 || uint256(secretHash) >= P) revert SecretHashOutOfRange(secretHash);
        return abi.encode(PP_BRIDGE_DATA_V1, secretHash);
    }

    /// @notice Inbox content preimage, 128 bytes. Reverts `FieldOutOfRange` for a word ≥ P and
    /// `AmountOutOfRange` unless `1 ≤ amount ≤ 2^128 − 1`, checked in argument order.
    function bridgeContentPreimage(uint256 nullifier, uint256 changeCommitment, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        _field(nullifier);
        _field(changeCommitment);
        _amount(amount);
        return abi.encode(PP_BRIDGE_IN_V1, nullifier, changeCommitment, amount);
    }

    /// @notice Screened public-exit content preimage, 96 bytes. Reverts `ZeroPayee`, then `AmountOutOfRange`.
    function exitContentPreimage(address payee, uint256 amount) internal pure returns (bytes memory) {
        _payee(payee);
        _amount(amount);
        return abi.encode(PP_BRIDGE_OUT_V1, payee, amount);
    }

    /// @notice Ragequit content preimage, 128 bytes. Reverts `ZeroPayee`, `AmountOutOfRange`, then
    /// `LabelOutOfRange` unless `0 < label < P` (label 0 is the public exit in `ExitSettled`).
    function ragequitContentPreimage(address payee, uint256 amount, uint256 label) internal pure returns (bytes memory) {
        _payee(payee);
        _amount(amount);
        if (label == 0 || label >= P) revert LabelOutOfRange(label);
        return abi.encode(PP_BRIDGE_RAGEQUIT_V1, payee, amount, label);
    }

    /// @notice `H(IN_V1, nullifier, changeCommitment, amount)`: the content of the bridge's Inbox message.
    function bridgeContent(uint256 nullifier, uint256 changeCommitment, uint256 amount) internal pure returns (bytes32) {
        return Hash.sha256ToField(bridgeContentPreimage(nullifier, changeCommitment, amount));
    }

    /// @notice `H(OUT_V1, payee, amount)`: the content of a screened public exit's Outbox message.
    function exitContent(address payee, uint256 amount) internal pure returns (bytes32) {
        return Hash.sha256ToField(exitContentPreimage(payee, amount));
    }

    /// @notice `H(RAGEQUIT_V1, payee, amount, label)`: the content of a ragequit's Outbox message.
    function ragequitContent(address payee, uint256 amount, uint256 label) internal pure returns (bytes32) {
        return Hash.sha256ToField(ragequitContentPreimage(payee, amount, label));
    }

    function _field(uint256 value) private pure {
        if (value >= P) revert FieldOutOfRange(value);
    }

    function _amount(uint256 amount) private pure {
        if (amount == 0 || amount > type(uint128).max) revert AmountOutOfRange(amount);
    }

    function _payee(address payee) private pure {
        if (payee == address(0)) revert ZeroPayee();
    }
}
