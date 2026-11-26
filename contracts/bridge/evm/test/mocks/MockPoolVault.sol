// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";

import {IPrivacyPoolVault} from "../../src/interfaces/IPrivacyPoolVault.sol";

/// An ERC-20-only subset of Privacy Pools v2's `PoolVault.transact`: the processor, context-binding,
/// nullifier-replay and token-id checks, and the payout to the caller. No proof, root or
/// output-commitment checks and no native-asset branch, so a test that needs the vault itself to
/// accept a spend uses the real one. A mode makes it misbehave so the portal's own checks carry the weight.
contract MockPoolVault is IPrivacyPoolVault {
    using SafeERC20 for IERC20;

    enum Mode {
        Honest,
        ShortPay,
        OverPay,
        NoPay,
        OtherToken,
        Reenter,
        Revert
    }

    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidProcessor();
    error ContextMismatch();
    error NullifierAlreadySpent();
    error TokenIdNotCanonical();
    error TokenIdMustBeZero();
    error VaultReverted();

    Mode public mode;
    uint256 public delta;
    IERC20 public otherToken;
    bytes public reentry;
    uint256 public calls;
    mapping(uint256 nullifier => bool) public spent;

    function setMode(Mode m, uint256 d) external {
        mode = m;
        delta = d;
    }

    function setOtherToken(IERC20 t) external {
        otherToken = t;
    }

    /// Calldata the vault replays into its caller mid-`transact`; a refusal propagates, so the outer entry reverts too.
    function setReentry(bytes calldata data) external {
        reentry = data;
    }

    /// The context a client proves: the vault binds exactly these bytes.
    function contextOf(TransactParams memory params, NoteData[] memory noteData) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(params, noteData))) % P;
    }

    function transact(TransactProof calldata proof, TransactParams calldata params, NoteData[] calldata noteData)
        external
    {
        if (params.processor != msg.sender) revert InvalidProcessor();
        if (proof.pubSignals[7][0] != uint256(keccak256(abi.encode(params, noteData))) % P) revert ContextMismatch();
        uint256[] calldata nullifiers = proof.pubSignals[0];
        for (uint256 i; i < nullifiers.length; ++i) {
            if (spent[nullifiers[i]]) revert NullifierAlreadySpent();
            spent[nullifiers[i]] = true;
        }
        calls++;

        if (mode == Mode.Revert) revert VaultReverted();
        if (mode == Mode.Reenter) {
            (bool ok, bytes memory ret) = msg.sender.call(reentry);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }

        uint256 amount = proof.pubSignals[5][0];
        uint256 raw = proof.pubSignals[6][0];
        if (raw >> 160 != 0) revert TokenIdNotCanonical();
        if (amount == 0) {
            if (raw != 0) revert TokenIdMustBeZero();
            return;
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        IERC20 token = IERC20(address(uint160(raw)));
        if (mode == Mode.ShortPay) amount -= delta;
        else if (mode == Mode.OverPay) amount += delta;
        else if (mode == Mode.NoPay) amount = 0;
        else if (mode == Mode.OtherToken) token = otherToken;
        if (amount > 0) token.safeTransfer(msg.sender, amount);
    }
}
