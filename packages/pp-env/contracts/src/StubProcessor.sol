// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVaultMinimal} from "./IPoolVaultMinimal.sol";

/// @title StubProcessor
/// @notice Local test fixture in the processor role: submits a one-input, one-output pool spend bound to
///         this contract and records what the pool paid.
/// @dev Submission is permissionless by design. The proof's context binds `processor` and `data`, so
///      whoever submits, the payout lands here and nowhere else.
contract StubProcessor {
    struct Spend {
        address asset;
        uint256 amount;
        uint256 nullifier;
        uint256 changeCommitment;
    }

    IPoolVaultMinimal public immutable POOL;
    IERC20 public immutable TOKEN;

    Spend public lastSpend;
    uint256 public spendCount;

    event Processed(uint256 indexed nullifier, uint256 changeCommitment, address asset, uint256 amount, bytes data);

    error NotOneInOneOut(uint256 nullifiers, uint256 commitments);
    error UnexpectedToken(uint256 tokenIdOut);
    error PaymentMismatch(uint256 expected, uint256 received);

    constructor(IPoolVaultMinimal pool, IERC20 token) {
        POOL = pool;
        TOKEN = token;
    }

    function spend(
        IPoolVaultMinimal.TransactProof calldata proof,
        IPoolVaultMinimal.TransactParams calldata params,
        IPoolVaultMinimal.NoteData[] calldata noteData
    ) external {
        uint256[][] calldata s = proof.pubSignals;
        if (s[0].length != 1 || s[1].length != 1) revert NotOneInOneOut(s[0].length, s[1].length);
        // The pool would pay any enabled asset; this fixture only accounts for its own token.
        if (s[6][0] != uint256(uint160(address(TOKEN)))) revert UnexpectedToken(s[6][0]);

        uint256 balanceBefore = TOKEN.balanceOf(address(this));
        POOL.transact(proof, params, noteData);
        uint256 received = TOKEN.balanceOf(address(this)) - balanceBefore;
        if (received != s[5][0]) revert PaymentMismatch(s[5][0], received);

        lastSpend = Spend({asset: address(TOKEN), amount: received, nullifier: s[0][0], changeCommitment: s[1][0]});
        ++spendCount;
        emit Processed(s[0][0], s[1][0], address(TOKEN), received, params.data);
    }
}
