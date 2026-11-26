// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

/// @notice The one Privacy Pools v2 `PoolVault` call a processor makes, declared from the vault's
/// ABI. The struct layouts fix the selector (`0x85afaff4`), which a unit test pins.
/// @dev `pubSignals` rows: [0] nullifiers, [1] output commitments, [2] state root, [3] keystore root,
/// [4] ASP root, [5] amountOut, [6] tokenIdOut, [7] context. The vault reads rows 2–7 at index 0 only.
interface IPrivacyPoolVault {
    struct TransactProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[][] pubSignals;
    }

    struct TransactParams {
        address processor;
        bytes data;
    }

    struct NoteData {
        bytes32 hint;
        bytes data;
    }

    /// @dev Requires `params.processor == msg.sender` and
    /// `context == keccak256(abi.encode(params, noteData)) % p`; pays `amountOut` of `tokenIdOut` to the caller.
    function transact(TransactProof calldata proof, TransactParams calldata params, NoteData[] calldata noteData)
        external;
}
