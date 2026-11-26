// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";
import {MockPoolVault} from "./mocks/MockPoolVault.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";
import {SurchargeERC20} from "./mocks/PayoutERC20s.sol";
import {TrapInbox} from "./mocks/TrapInbox.sol";

/// Unit suite for the processor portal clone, on the Aztec fakes and the mock vault.
contract ProcessorPortalTest is PortalFixture {
    address internal constant PAYEE = address(0xBEEF);
    uint256 internal constant LABEL = 0x1abe1;

    function setUp() public {
        _deploy(type(uint256).max);
    }

    /// Our declaration must reach the real vault: `0x85afaff4` is `transact` in Privacy Pools v2's
    /// compiled PoolVault at the pinned commit.
    function test_vaultSelector_matchesThePool() public pure {
        assertEq(IPrivacyPoolVault.transact.selector, bytes4(0x85afaff4));
        assertEq(
            IPrivacyPoolVault.transact.selector,
            bytes4(keccak256("transact((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[])"))
        );
    }

    // ─── bridgeFromPool ──────────────────────────────────────────────────────

    function test_bridge_creditsExactlyAndSendsOneMessage() public {
        (IPrivacyPoolVault.TransactProof memory proof, uint256 nullifier) = _proof(portal, 1000, SECRET_HASH);
        uint256 change = nullifier + 1000;
        bytes32 content = BridgeMessageV1.bridgeContent(nullifier, change, 1000);
        uint256 sent = inbox.sent();

        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.BridgedFromPool(keccak256(abi.encode(content, SECRET_HASH)), sent, nullifier, change, 1000);
        (bytes32 key, uint256 index) = portal.bridgeFromPool(proof, _notes(), SECRET_HASH);

        assertEq(portal.grossAccepted(), 1000);
        assertEq(token.balanceOf(address(portal)), 1000);
        assertEq(inbox.sent(), sent + 1, "exactly one message");
        assertEq(inbox.lastBridge(), HUB);
        assertEq(inbox.lastVersion(), VERSION);
        assertEq(inbox.lastSender(), address(portal));
        assertEq(inbox.lastContentHash(), content);
        assertEq(inbox.lastSecretHash(), SECRET_HASH);
        assertEq(key, keccak256(abi.encode(content, SECRET_HASH)));
        assertEq(index, sent);
    }

    function test_bridge_refusedWhilePaused() public {
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(true);
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
        vm.expectRevert(ProcessorPortalImpl.EntriesPaused.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    function test_bridge_refusesEveryShapeButOneByOne() public {
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
        uint256[][] memory valid = proof.pubSignals;

        uint256[][] memory short = new uint256[][](7);
        for (uint256 i; i < 7; ++i) {
            short[i] = valid[i];
        }
        uint256[][] memory long = new uint256[][](9);
        for (uint256 i; i < 8; ++i) {
            long[i] = valid[i];
        }
        long[8] = new uint256[](1);
        _expectShapeRefused(short);
        _expectShapeRefused(long);
        for (uint256 row; row < 8; ++row) {
            uint256[][] memory wide = _copy(valid);
            wide[row] = new uint256[](2);
            wide[row][0] = valid[row][0];
            _expectShapeRefused(wide);
            uint256[][] memory empty = _copy(valid);
            empty[row] = new uint256[](0);
            _expectShapeRefused(empty);
        }
    }

    function test_bridge_refusesAnyOtherTokenId() public {
        uint256[3] memory ids =
            [uint256(uint160(address(new PlainERC20("O", "O")))), uint160(NATIVE_ASSET), uint160(address(token)) | (1 << 160)];
        for (uint256 i; i < ids.length; ++i) {
            (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
            proof.pubSignals[6][0] = ids[i];
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.WrongToken.selector, ids[i]));
            portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        }
    }

    function test_bridge_rangeChecksComeFromTheWireFormat() public {
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.SecretHashOutOfRange.selector, bytes32(0)));
        portal.bridgeFromPool(proof, _notes(), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.SecretHashOutOfRange.selector, bytes32(P)));
        portal.bridgeFromPool(proof, _notes(), bytes32(P));

        uint256[2] memory badAmounts = [uint256(0), uint256(1) << 128];
        for (uint256 i; i < 2; ++i) {
            (proof,) = _proof(portal, badAmounts[i], SECRET_HASH);
            vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.AmountOutOfRange.selector, badAmounts[i]));
            portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        }
        (proof,) = _proof(portal, 1000, SECRET_HASH);
        proof.pubSignals[0][0] = P;
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.FieldOutOfRange.selector, P));
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        assertEq(vault.calls(), 0, "a refused bridge reached the vault");
    }

    function test_bridge_neverAcceptsPastTheCap() public {
        _deploy(1000);
        _bridge(portal, 600);
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 401, SECRET_HASH);
        vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.CapExceeded.selector, 600, 401));
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        _bridge(portal, 400);
        assertEq(portal.grossAccepted(), 1000);
    }

    function test_bridge_refusesAnyPaymentButExact() public {
        uint256 amount = 1000;
        MockPoolVault.Mode[4] memory modes =
            [MockPoolVault.Mode.ShortPay, MockPoolVault.Mode.OverPay, MockPoolVault.Mode.NoPay, MockPoolVault.Mode.OtherToken];
        uint256[4] memory received = [amount - 1, amount + 1, 0, 0];
        PlainERC20 other = new PlainERC20("O", "O");
        other.mint(address(vault), amount);
        vault.setOtherToken(other);
        for (uint256 i; i < modes.length; ++i) {
            vault.setMode(modes[i], 1);
            (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, amount, SECRET_HASH);
            vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.InexactPayment.selector, amount, received[i]));
            portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        }
        assertEq(portal.grossAccepted(), 0);
        assertEq(inbox.sent(), 1, "only the registration message");
    }

    function test_bridge_vaultRevertPropagates() public {
        vault.setMode(MockPoolVault.Mode.Revert, 0);
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
        vm.expectRevert(MockPoolVault.VaultReverted.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    function test_bridge_inboxRevertRollsTheSpendBack() public {
        vm.etch(address(inbox), address(new TrapInbox()).code);
        (IPrivacyPoolVault.TransactProof memory proof, uint256 nullifier) = _proof(portal, 1000, SECRET_HASH);
        uint256 vaultBalance = token.balanceOf(address(vault));
        vm.expectRevert(TrapInbox.InboxCalled.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        assertEq(portal.grossAccepted(), 0);
        assertEq(token.balanceOf(address(portal)), 0);
        assertEq(token.balanceOf(address(vault)), vaultBalance);
        assertFalse(vault.spent(nullifier), "the nullifier stayed spent");
    }

    function test_bridge_vaultReentryIsRefused() public {
        _bridge(portal, 1000);
        (IPrivacyPoolVault.TransactProof memory inner,) = _proof(portal, 1, SECRET_HASH);
        bytes[2] memory reentries = [
            abi.encodeCall(ProcessorPortalImpl.bridgeFromPool, (inner, _notes(), SECRET_HASH)),
            abi.encodeCall(ProcessorPortalImpl.settlePublicExit, (PAYEE, 1, Epoch.wrap(1), 1, 0, new bytes32[](0)))
        ];
        vault.setMode(MockPoolVault.Mode.Reenter, 0);
        for (uint256 i; i < 2; ++i) {
            vault.setReentry(reentries[i]);
            (IPrivacyPoolVault.TransactProof memory proof,) = _proof(portal, 1000, SECRET_HASH);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
        }
    }

    function test_implementation_refusesToBridge() public {
        ProcessorPortalImpl impl = ProcessorPortalImpl(address(factory.IMPLEMENTATION()));
        IPrivacyPoolVault.TransactProof memory proof;
        proof.pubSignals = _signals(1, 2, 1000, uint160(address(token)), 0);
        vm.expectRevert(ProcessorPortalImpl.ImplementationOnly.selector);
        impl.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    // ─── settleRagequit / settlePublicExit ───────────────────────────────────

    function test_settleRagequit_paysExactlyAndConsumesItsMessage() public {
        _bridge(portal, 1000);
        bytes32[] memory path = new bytes32[](2);
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(PAYEE, 400, LABEL, Epoch.wrap(9), (1 << 2) + 3);
        portal.settleRagequit(PAYEE, 400, LABEL, Epoch.wrap(9), 1, 3, path);

        assertEq(token.balanceOf(PAYEE), 400);
        assertEq(token.balanceOf(address(portal)), 600);
        assertEq(portal.totalPaid(), 400);
        _assertConsumed(BridgeMessageV1.ragequitContent(PAYEE, 400, LABEL));
    }

    function test_settlePublicExit_paysExactlyWithLabelZero() public {
        _bridge(portal, 1000);
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(PAYEE, 250, 0, Epoch.wrap(1), 1);
        _settlePublicExit(portal, PAYEE, 250);

        assertEq(token.balanceOf(PAYEE), 250);
        assertEq(portal.totalPaid(), 250);
        _assertConsumed(BridgeMessageV1.exitContent(PAYEE, 250));
    }

    function test_settle_paysWhileEntriesArePaused() public {
        _bridge(portal, 1000);
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(true);
        _settleRagequit(portal, PAYEE, 300, LABEL);
        _settlePublicExit(portal, PAYEE, 200);
        assertEq(token.balanceOf(PAYEE), 500);
    }

    function test_settle_refusesBadPayeeOrLabel() public {
        _bridge(portal, 1000);
        vm.expectRevert(ProcessorPortalImpl.PayeeIsPortal.selector);
        _settleRagequit(portal, address(portal), 1, LABEL);
        vm.expectRevert(ProcessorPortalImpl.PayeeIsPortal.selector);
        _settlePublicExit(portal, address(portal), 1);
        vm.expectRevert(BridgeMessageV1.ZeroPayee.selector);
        _settleRagequit(portal, address(0), 1, LABEL);
        vm.expectRevert(BridgeMessageV1.ZeroPayee.selector);
        _settlePublicExit(portal, address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.LabelOutOfRange.selector, 0));
        _settleRagequit(portal, PAYEE, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.LabelOutOfRange.selector, P));
        _settleRagequit(portal, PAYEE, 1, P);
        vm.expectRevert(abi.encodeWithSelector(BridgeMessageV1.AmountOutOfRange.selector, 0));
        _settlePublicExit(portal, PAYEE, 0);
    }

    function test_settle_neverPaysPastTheReserveNorADonation() public {
        _bridge(portal, 1000);
        token.mint(address(portal), 5000);
        vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, 1000, 1001));
        _settlePublicExit(portal, PAYEE, 1001);
        _settleRagequit(portal, PAYEE, 1000, LABEL);
        vm.expectRevert(abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, 0, 1));
        _settlePublicExit(portal, PAYEE, 1);
        assertEq(token.balanceOf(address(portal)), 5000, "the donation was paid out");
    }

    function test_settle_refusesAPayoutThatDebitsMore() public {
        SurchargeERC20 sur = new SurchargeERC20();
        sur.mint(address(vault), 1 << 100);
        ProcessorPortalImpl clone = ProcessorPortalImpl(factory.createPortal(address(sur)));
        _bridge(clone, 1000);
        vm.expectRevert(ProcessorPortalImpl.InexactTransfer.selector);
        _settlePublicExit(clone, PAYEE, 400);
        assertEq(clone.totalPaid(), 0);
        assertEq(sur.balanceOf(address(clone)), 1000);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _assertConsumed(bytes32 content) internal view {
        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        assertEq(m.sender.actor, HUB);
        assertEq(m.sender.version, VERSION);
        assertEq(m.recipient.actor, address(portal));
        assertEq(m.recipient.chainId, block.chainid);
        assertEq(m.content, content);
    }

    function _expectShapeRefused(uint256[][] memory signals) internal {
        IPrivacyPoolVault.TransactProof memory proof;
        proof.pubSignals = signals;
        vm.expectRevert(ProcessorPortalImpl.BadSignalShape.selector);
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    function _copy(uint256[][] memory s) internal pure returns (uint256[][] memory c) {
        c = new uint256[][](s.length);
        for (uint256 i; i < s.length; ++i) {
            c[i] = s[i];
        }
    }
}
