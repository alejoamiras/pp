// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {IPrivacyPoolVault} from "../../src/interfaces/IPrivacyPoolVault.sol";

/// The halmos vault: pays `amountOut` of `tokenIdOut` to its caller, or misbehaves. No context or
/// replay checks: those are the vault's, and MockPoolVault reimplements them for forge.
/// `Trap` reverts with its own error, so a proof can tell "refused before the vault" from "refused by it":
/// a call counter cannot, because the portal's revert rolls it back.
contract SymbolicVault is IPrivacyPoolVault {
    enum Mode {
        Honest,
        ShortPay,
        OverPay,
        NoPay,
        Trap
    }

    error VaultCalled();
    error TransferFailed();

    Mode public mode;

    function setMode(Mode m) external {
        mode = m;
    }

    function transact(TransactProof calldata proof, TransactParams calldata, NoteData[] calldata) external {
        if (mode == Mode.Trap) revert VaultCalled();
        uint256 amount = proof.pubSignals[5][0];
        if (mode == Mode.ShortPay) amount -= 1;
        else if (mode == Mode.OverPay) amount += 1;
        else if (mode == Mode.NoPay) amount = 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        IERC20 token = IERC20(address(uint160(proof.pubSignals[6][0])));
        if (amount > 0 && !token.transfer(msg.sender, amount)) revert TransferFailed();
    }
}
