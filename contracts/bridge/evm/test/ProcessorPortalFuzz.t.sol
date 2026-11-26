// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";
import {MockPoolVault} from "./mocks/MockPoolVault.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The unit suite's refusals over their whole input ranges, on the mock vault and capturing fakes.
/// Every refused bridge must leave the vault's money, the clone's counter and the Inbox untouched;
/// `_assertNothingMoved` checks that against a snapshot taken before the call.
contract ProcessorPortalFuzzTest is PortalFixture {
    uint256 internal constant CAP = 1 << 120;
    uint256 internal constant SEED = 1 << 60;

    uint256 private heldBefore;
    uint256 private grossBefore;
    uint256 private sentBefore;

    function setUp() public {
        _deploy(CAP);
        _bridge(portal, SEED);
    }

    /// Any row count but 8, or any row whose length is not 1, is refused before anything else.
    function testFuzz_bridge_refusesEveryOtherShape(uint8 rows, uint8 badRow, uint8 badLen, uint256 word) public {
        rows = uint8(bound(rows, 0, 12));
        uint256[][] memory s = new uint256[][](rows);
        for (uint256 i; i < rows; ++i) {
            s[i] = new uint256[](1);
            s[i][0] = word;
        }
        if (rows == 8) {
            badRow = uint8(bound(badRow, 0, 7));
            badLen = uint8(bound(badLen, 0, 4));
            vm.assume(badLen != 1);
            s[badRow] = new uint256[](badLen);
        }
        IPrivacyPoolVault.TransactProof memory proof;
        proof.pubSignals = s;
        _snapshot();
        vm.expectRevert(ProcessorPortalImpl.BadSignalShape.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _assertNothingMoved();
    }

    /// The wire format bounds the amount first, then the cap bounds what is left of it.
    function testFuzz_bridge_amountAndCap(uint256 amount, uint256 cap) public {
        cap = bound(cap, 1, type(uint128).max);
        amount = bound(amount, 0, uint256(type(uint128).max) + 2);
        _deploy(cap);
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, amount, SECRET_HASH);
        _snapshot();
        if (amount == 0 || amount > type(uint128).max) {
            vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.AmountOutOfRange.selector, amount));
        } else if (amount > cap) {
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.CapExceeded.selector, 0, amount));
        } else {
            portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
            assertEq(portal.grossAccepted(), amount);
            assertEq(token.balanceOf(address(portal)), amount);
            assertEq(inbox.sent(), sentBefore + 1);
            return;
        }
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _assertNothingMoved();
    }

    function testFuzz_bridge_secretHashRange(bytes32 secretHash, bool edge) public {
        if (edge) secretHash = bytes32(bound(uint256(secretHash), P - 2, P + 2));
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, secretHash);
        _snapshot();
        if (secretHash == 0 || uint256(secretHash) >= P) {
            vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.SecretHashOutOfRange.selector, secretHash));
            portal.bridgeFromPool(proof, _notes(), secretHash);
            _assertNothingMoved();
        } else {
            portal.bridgeFromPool(proof, _notes(), secretHash);
            assertEq(inbox.lastSecretHash(), secretHash);
        }
    }

    /// Any id but the clone's own token, including the native-asset sentinel and ids above 160 bits.
    function testFuzz_bridge_refusesAnyOtherTokenId(uint256 tokenId, uint8 pick) public {
        uint256[3] memory specials = [uint256(uint160(NATIVE_ASSET)), uint256(uint160(address(token))) | (1 << 160), 0];
        if (pick < 3) tokenId = specials[pick];
        vm.assume(tokenId != uint160(address(token)));
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
        proof.pubSignals[6][0] = tokenId;
        _snapshot();
        vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.WrongToken.selector, tokenId));
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _assertNothingMoved();
    }

    /// Each way a vault can fail to pay exactly is refused with nothing credited or sent.
    function testFuzz_bridge_everyVaultFailureIsRefused(uint8 mode, uint256 delta, uint256 amount) public {
        MockPoolVault.Mode m = MockPoolVault.Mode(bound(mode, 1, uint8(type(MockPoolVault.Mode).max)));
        amount = bound(amount, 1, 1 << 100);
        delta = bound(delta, 1, amount);
        vault.setMode(m, delta);
        PlainERC20 other = new PlainERC20("Oth", "OTH");
        other.mint(address(vault), 1 << 200);
        vault.setOtherToken(other);
        vault.setReentry(
            abi.encodeCall(
                ProcessorPortalImpl.settlePublicExit, (address(0xBEEF), 1, Epoch.wrap(1), 1, 0, new bytes32[](0))
            )
        );
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, amount, SECRET_HASH);
        _snapshot();

        if (m == MockPoolVault.Mode.ShortPay) {
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.InexactPayment.selector, amount, amount - delta));
        } else if (m == MockPoolVault.Mode.OverPay) {
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.InexactPayment.selector, amount, amount + delta));
        } else if (m == MockPoolVault.Mode.NoPay || m == MockPoolVault.Mode.OtherToken) {
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.InexactPayment.selector, amount, 0));
        } else if (m == MockPoolVault.Mode.Reenter) {
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        } else {
            vm.expectRevert(MockPoolVault.VaultReverted.selector);
        }
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _assertNothingMoved();
        assertEq(other.balanceOf(address(portal)), 0);
    }

    /// The vault checks the context against the params the portal sends, so a proof made for another
    /// processor, another secret hash or other notes is refused.
    function testFuzz_bridge_contextBindsProcessorDataAndNotes(
        address processor,
        bytes32 secretHash,
        bytes32 hint,
        uint8 which
    ) public {
        which = uint8(bound(which, 0, 2));
        IPrivacyPoolVault.NoteData[] memory notes = _notes();
        bytes memory data = abi.encode(BridgeMessageV1.PP_BRIDGE_DATA_V1, SECRET_HASH);
        address forProcessor = address(portal);
        if (which == 0) {
            vm.assume(processor != address(portal));
            forProcessor = processor;
        } else if (which == 1) {
            vm.assume(secretHash != SECRET_HASH);
            data = abi.encode(BridgeMessageV1.PP_BRIDGE_DATA_V1, secretHash);
        } else {
            vm.assume(hint != notes[0].hint);
            notes[0].hint = hint;
        }
        IPrivacyPoolVault.TransactProof memory proof;
        proof.pubSignals = _signals(7, 8, 1000, uint160(address(token)), _context(forProcessor, data, notes));
        _snapshot();
        vm.expectRevert(MockPoolVault.ContextMismatch.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _assertNothingMoved();
    }

    function testFuzz_settle_payee(address payee, bool ragequit, uint256 label, uint256 amount) public {
        amount = bound(amount, 1, SEED);
        label = ragequit ? bound(label, 1, P - 1) : 0;
        uint256 before = token.balanceOf(payee);
        if (payee == address(0)) {
            vm.expectRevert(BridgeMessageV1.ZeroPayee.selector);
        } else if (payee == address(portal)) {
            vm.expectRevert(ProcessorPortalImpl.PayeeIsPortal.selector);
        }
        if (ragequit) _settleRagequit(portal, payee, amount, label);
        else _settlePublicExit(portal, payee, amount);
        if (payee != address(0) && payee != address(portal)) {
            assertEq(token.balanceOf(payee), before + amount);
            assertEq(portal.totalPaid(), amount);
        }
    }

    /// Donations raise the balance but never the reserve: exits draw only on what bridges accepted.
    function testFuzz_settle_reserveIgnoresDonations(uint256 donated, uint256 paidFirst, uint256 amount) public {
        donated = bound(donated, 0, 1 << 100);
        paidFirst = bound(paidFirst, 0, SEED);
        amount = bound(amount, 1, SEED + donated + 1);
        token.mint(address(portal), donated);
        if (paidFirst > 0) _settlePublicExit(portal, address(0xA11CE), paidFirst);
        uint256 outstanding = SEED - paidFirst;
        if (amount > outstanding) {
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, outstanding, amount));
        }
        _settlePublicExit(portal, address(0xB0B), amount);
        if (amount <= outstanding) assertEq(portal.totalPaid(), paidFirst + amount);
        else assertEq(portal.totalPaid(), paidFirst);
        assertEq(token.balanceOf(address(portal)), SEED + donated - portal.totalPaid());
    }

    function _snapshot() internal {
        heldBefore = token.balanceOf(address(portal));
        grossBefore = portal.grossAccepted();
        sentBefore = inbox.sent();
    }

    function _assertNothingMoved() internal view {
        assertEq(token.balanceOf(address(portal)), heldBefore, "held");
        assertEq(portal.grossAccepted(), grossBefore, "grossAccepted");
        assertEq(inbox.sent(), sentBefore, "messages");
    }
}
