// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice The slice of Privacy Pools v2's PoolVault a processor calls, declared from its ABI.
/// @dev `pubSignals` rows: [0] nullifiers, [1] output commitments, [2] state root, [3] keystore root,
///      [4] ASP root, [5] amountOut, [6] tokenIdOut, [7] context.
interface IPoolVaultMinimal {
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

    /// @dev Reverts unless `params.processor == msg.sender`; pays amountOut of tokenIdOut to msg.sender.
    function transact(TransactProof calldata proof, TransactParams calldata params, NoteData[] calldata noteData)
        external;
}
