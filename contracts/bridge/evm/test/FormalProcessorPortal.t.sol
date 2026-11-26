// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {ProcessorPortalHarness} from "./harness/ProcessorPortalHarness.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";
import {SymbolicVault} from "./mocks/SymbolicVault.sol";

/// SYMBOLIC checks for the processor portal (run with `halmos`, not forge): arguments are symbolic,
/// so each check proves its property over the whole input domain it assumes.
///
///   check_bridge_valid_accountsExactly — a valid bridge credits exactly `amount`, holds exactly
///     `amount` more, and sends one Inbox message carrying the wire-format preimage's hash
///   check_settle_anyPause_paysExactly — in either pause state, either settle pays exactly `amount`
///     to `payee`, counts it, and consumes the message for the wire-format preimage
///   check_bridge_{paused,badShape,wrongToken,secretHashOutOfRange,overCap}_revertsBeforePool — each
///     refusal names its own error while the vault is a trap that reverts `VaultCalled` if reached
///   check_bridge_inexactPayment_reverts — a short, over or missing payment reverts, sending nothing
///   check_settle_aboveReserve_reverts — no settle above `grossAccepted - totalPaid`, paused or not
///   check_settle_badPayeeOrLabel_reverts — payee 0, the clone itself, or a ragequit label 0 or ≥ p
///
/// halmos passes any path that reverts, so each success call sits in a try whose catch fails the
/// proof: valid inputs must succeed, which is what makes "in either pause state" a claim and not a
/// vacuity. Each refusal proof compares the whole revert data, and its canary below shows that the
/// same call with only that guard's condition lifted reaches the trap.
///
/// halmos cannot run sha256, so the proofs drive `ProcessorPortalHarness`, whose only difference is a
/// keccak content hash; `check-halmos.sh` checks that difference at the compiled level. The harness is
/// created by the real factory's address (so its `FACTORY` reads the real pause) and cloned with
/// `Clones` directly, since `createPortal` hashes its register message with sha256.
contract FormalProcessorPortalTest is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address internal constant GUARDIAN = address(0x6A);
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    uint256 internal constant CAP = 1 << 127;
    uint256 internal constant SEED = 1 << 100;

    PortalFactory internal factory;
    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    SymbolicVault internal vault;
    PlainERC20 internal token;
    ProcessorPortalHarness internal harness;
    ProcessorPortalImpl internal clone;

    function setUp() public {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        IRegistry registry =
            IRegistry(address(new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))))));
        vault = new SymbolicVault();
        factory = new PortalFactory(registry, HUB, IPrivacyPoolVault(address(vault)), CAP, GUARDIAN);
        vm.prank(address(factory));
        harness = new ProcessorPortalHarness(registry, HUB, IPrivacyPoolVault(address(vault)), CAP);
        token = new PlainERC20("Tok", "TOK");
        token.mint(address(vault), 1 << 200);
        clone = ProcessorPortalImpl(
            Clones.cloneDeterministicWithImmutableArgs(address(harness), abi.encodePacked(address(token)), bytes32(0))
        );
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(false);
        // A reserve for the settle proofs to pay from.
        clone.bridgeFromPool(_proof(1, 2, SEED), _notes(), bytes32(uint256(3)));
    }

    function check_bridge_valid_accountsExactly(uint256 nullifier, uint256 change, uint256 amount, bytes32 secretHash)
        public
    {
        vm.assume(nullifier < P && change < P);
        vm.assume(amount > 0 && amount <= type(uint128).max && amount <= CAP - clone.grossAccepted());
        vm.assume(uint256(secretHash) > 0 && uint256(secretHash) < P);
        uint256 gross = clone.grossAccepted();
        uint256 held = token.balanceOf(address(clone));
        uint256 sent = inbox.sent();

        try clone.bridgeFromPool(_proof(nullifier, change, amount), _notes(), secretHash) {}
        catch {
            assert(false);
        }

        assert(clone.grossAccepted() == gross + amount);
        assert(token.balanceOf(address(clone)) == held + amount);
        assert(inbox.sent() == sent + 1);
        assert(inbox.lastSender() == address(clone));
        assert(inbox.lastBridge() == HUB);
        assert(inbox.lastSecretHash() == secretHash);
        assert(inbox.lastContentHash() == _hash(BridgeMessageV1.bridgeContentPreimage(nullifier, change, amount)));
    }

    function check_settle_anyPause_paysExactly(bool paused, bool ragequit, address payee, uint256 amount, uint256 label)
        public
    {
        vm.assume(payee != address(0) && payee != address(clone));
        vm.assume(amount > 0 && amount <= clone.grossAccepted() - clone.totalPaid());
        if (ragequit) vm.assume(label > 0 && label < P);
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(paused);
        uint256 received = token.balanceOf(payee);
        uint256 held = token.balanceOf(address(clone));
        uint256 paid = clone.totalPaid();

        bytes memory preimage;
        if (ragequit) {
            try clone.settleRagequit(payee, amount, label, Epoch.wrap(1), 1, 0, new bytes32[](0)) {}
            catch {
                assert(false);
            }
            preimage = BridgeMessageV1.ragequitContentPreimage(payee, amount, label);
        } else {
            try clone.settlePublicExit(payee, amount, Epoch.wrap(1), 1, 0, new bytes32[](0)) {}
            catch {
                assert(false);
            }
            preimage = BridgeMessageV1.exitContentPreimage(payee, amount);
        }

        assert(token.balanceOf(payee) == received + amount);
        assert(token.balanceOf(address(clone)) == held - amount);
        assert(clone.totalPaid() == paid + amount);
        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        assert(m.content == _hash(preimage));
        assert(m.recipient.actor == address(clone));
        assert(m.sender.actor == HUB);
    }

    // ─── Refusals ────────────────────────────────────────────────────────────

    function check_bridge_paused_revertsBeforePool(
        uint256 nullifier,
        uint256 change,
        uint256 amount,
        uint256 tokenId,
        bytes32 secretHash
    ) public {
        vault.setMode(SymbolicVault.Mode.Trap);
        _pause(true);
        _assertBridgeRefused(
            _signals(nullifier, change, amount, tokenId),
            secretHash,
            abi.encodeWithSelector(ProcessorPortalImpl.EntriesPaused.selector)
        );
    }

    /// Shapes are concrete, words symbolic: every row at length 0 and 2 in turn, and 7 or 9 rows.
    function check_bridge_badShape_revertsBeforePool(uint256 word, bytes32 secretHash) public {
        vault.setMode(SymbolicVault.Mode.Trap);
        bytes memory refused = abi.encodeWithSelector(ProcessorPortalImpl.BadSignalShape.selector);
        for (uint256 row; row < 8; ++row) {
            for (uint256 len; len < 3; len += 2) {
                uint256[][] memory s = _signals(word, word, word, uint160(address(token)));
                s[row] = new uint256[](len);
                _assertBridgeRefused(s, secretHash, refused);
            }
        }
        uint256[2] memory rows = [uint256(7), 9];
        for (uint256 i; i < 2; ++i) {
            uint256[][] memory s = new uint256[][](rows[i]);
            for (uint256 r; r < rows[i]; ++r) {
                s[r] = new uint256[](1);
                s[r][0] = word;
            }
            _assertBridgeRefused(s, secretHash, refused);
        }
    }

    function check_bridge_wrongToken_revertsBeforePool(
        uint256 nullifier,
        uint256 change,
        uint256 amount,
        uint256 tokenId,
        bytes32 secretHash
    ) public {
        vm.assume(tokenId != uint160(address(token)));
        vault.setMode(SymbolicVault.Mode.Trap);
        _assertBridgeRefused(
            _signals(nullifier, change, amount, tokenId),
            secretHash,
            abi.encodeWithSelector(ProcessorPortalImpl.WrongToken.selector, tokenId)
        );
    }

    function check_bridge_secretHashOutOfRange_revertsBeforePool(
        uint256 nullifier,
        uint256 change,
        uint256 amount,
        bytes32 secretHash
    ) public {
        vm.assume(secretHash == 0 || uint256(secretHash) >= P);
        vault.setMode(SymbolicVault.Mode.Trap);
        _assertBridgeRefused(
            _signals(nullifier, change, amount, uint160(address(token))),
            secretHash,
            abi.encodeWithSelector(BridgeMessageV1.SecretHashOutOfRange.selector, secretHash)
        );
    }

    /// Every amount the wire format accepts that the cap does not.
    function check_bridge_overCap_revertsBeforePool(
        uint256 nullifier,
        uint256 change,
        uint256 amount,
        bytes32 secretHash
    ) public {
        uint256 gross = clone.grossAccepted();
        _assumeWireValid(nullifier, change, amount, secretHash);
        vm.assume(amount > CAP - gross);
        vault.setMode(SymbolicVault.Mode.Trap);
        _assertBridgeRefused(
            _signals(nullifier, change, amount, uint160(address(token))),
            secretHash,
            abi.encodeWithSelector(ProcessorPortalImpl.CapExceeded.selector, gross, amount)
        );
    }

    function check_bridge_inexactPayment_reverts(
        uint8 mode,
        uint256 nullifier,
        uint256 change,
        uint256 amount,
        bytes32 secretHash
    ) public {
        _assumeWireValid(nullifier, change, amount, secretHash);
        vm.assume(amount <= CAP - clone.grossAccepted());
        vm.assume(mode >= uint8(SymbolicVault.Mode.ShortPay) && mode <= uint8(SymbolicVault.Mode.NoPay));
        vault.setMode(SymbolicVault.Mode(mode));
        uint256 received = mode == uint8(SymbolicVault.Mode.ShortPay)
            ? amount - 1
            : mode == uint8(SymbolicVault.Mode.OverPay) ? amount + 1 : 0;
        _assertBridgeRefused(
            _signals(nullifier, change, amount, uint160(address(token))),
            secretHash,
            abi.encodeWithSelector(ProcessorPortalImpl.InexactPayment.selector, amount, received)
        );
    }

    function check_settle_aboveReserve_reverts(bool paused, bool ragequit, address payee, uint256 amount, uint256 label)
        public
    {
        vm.assume(payee != address(0) && payee != address(clone));
        vm.assume(amount > 0 && amount <= type(uint128).max);
        if (ragequit) vm.assume(label > 0 && label < P);
        uint256 outstanding = clone.grossAccepted() - clone.totalPaid();
        vm.assume(amount > outstanding);
        _pause(paused);
        _assertSettleRefused(
            ragequit,
            payee,
            amount,
            label,
            abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, outstanding, amount)
        );
    }

    function check_settle_badPayeeOrLabel_reverts(bool ragequit, address payee, uint256 amount, uint256 label) public {
        vm.assume(amount > 0 && amount <= clone.grossAccepted() - clone.totalPaid());
        bool badLabel = ragequit && (label == 0 || label >= P);
        vm.assume(payee == address(0) || payee == address(clone) || badLabel);
        bytes memory expected = payee == address(0)
            ? abi.encodeWithSelector(BridgeMessageV1.ZeroPayee.selector)
            : badLabel
                ? abi.encodeWithSelector(BridgeMessageV1.LabelOutOfRange.selector, label)
                : abi.encodeWithSelector(ProcessorPortalImpl.PayeeIsPortal.selector);
        _assertSettleRefused(ragequit, payee, amount, label, expected);
    }

    // ─── Canaries (forge): each refusal's guard is what stops the call ────────

    /// Each pair differs only in the guarded condition: refused by the portal, then the trap.
    function test_canary_eachBridgeGuardStandsBeforeTheVault() public {
        vault.setMode(SymbolicVault.Mode.Trap);
        bytes memory trapped = abi.encodeWithSelector(SymbolicVault.VaultCalled.selector);
        uint256 id = uint160(address(token));
        uint256[][] memory valid = _signals(1, 2, 1000, id);
        bytes32 secret = bytes32(uint256(3));

        _pause(true);
        _expectBridgeRevert(valid, secret, abi.encodeWithSelector(ProcessorPortalImpl.EntriesPaused.selector));
        _pause(false);
        _expectBridgeRevert(valid, secret, trapped);

        uint256[][] memory wide = _signals(1, 2, 1000, id);
        wide[3] = new uint256[](2);
        _expectBridgeRevert(wide, secret, abi.encodeWithSelector(ProcessorPortalImpl.BadSignalShape.selector));

        _expectBridgeRevert(
            _signals(1, 2, 1000, id + 1),
            secret,
            abi.encodeWithSelector(ProcessorPortalImpl.WrongToken.selector, id + 1)
        );
        _expectBridgeRevert(
            valid, bytes32(P), abi.encodeWithSelector(BridgeMessageV1.SecretHashOutOfRange.selector, bytes32(P))
        );
        uint256 over = CAP - SEED + 1;
        _expectBridgeRevert(
            _signals(1, 2, over, id),
            secret,
            abi.encodeWithSelector(ProcessorPortalImpl.CapExceeded.selector, SEED, over)
        );
        _expectBridgeRevert(_signals(1, 2, over - 1, id), secret, trapped);
    }

    function test_canary_honestPaymentAndValidSettlesPass() public {
        (bool ok,) = _bridgeCall(_signals(1, 2, 1000, uint160(address(token))), bytes32(uint256(3)));
        assertTrue(ok, "an honest payment was refused");
        uint256 outstanding = clone.grossAccepted() - clone.totalPaid();
        (ok,) = _settleCall(true, address(0xBEEF), outstanding, 1);
        assertTrue(ok, "a settle of exactly the reserve was refused");
        _expectSettleRevert(
            false, address(0xBEEF), 1, 0, abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, 0, 1)
        );
    }

    /// The harness binds to the real factory, so its pause is the one the proofs flip.
    function test_canary_harnessReadsTheFactory() public view {
        assertEq(address(harness.FACTORY()), address(factory));
        assertEq(address(clone.underlying()), address(token));
        assertEq(clone.grossAccepted(), SEED);
    }

    function _assumeWireValid(uint256 nullifier, uint256 change, uint256 amount, bytes32 secretHash) internal pure {
        vm.assume(nullifier < P && change < P);
        vm.assume(amount > 0 && amount <= type(uint128).max);
        vm.assume(uint256(secretHash) > 0 && uint256(secretHash) < P);
    }

    function _pause(bool paused) internal {
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(paused);
    }

    function _bridgeCall(uint256[][] memory signals, bytes32 secretHash) internal returns (bool, bytes memory) {
        IPrivacyPoolVault.TransactProof memory proof;
        proof.pubSignals = signals;
        return address(clone).call(abi.encodeCall(ProcessorPortalImpl.bridgeFromPool, (proof, _notes(), secretHash)));
    }

    function _settleCall(bool ragequit, address payee, uint256 amount, uint256 label)
        internal
        returns (bool, bytes memory)
    {
        bytes memory data = ragequit
            ? abi.encodeCall(
                ProcessorPortalImpl.settleRagequit, (payee, amount, label, Epoch.wrap(1), 1, 0, new bytes32[](0))
            )
            : abi.encodeCall(
                ProcessorPortalImpl.settlePublicExit, (payee, amount, Epoch.wrap(1), 1, 0, new bytes32[](0))
            );
        return address(clone).call(data);
    }

    function _assertBridgeRefused(uint256[][] memory signals, bytes32 secretHash, bytes memory expected) internal {
        (bool ok, bytes memory ret) = _bridgeCall(signals, secretHash);
        assert(!ok && keccak256(ret) == keccak256(expected));
    }

    function _assertSettleRefused(bool ragequit, address payee, uint256 amount, uint256 label, bytes memory expected)
        internal
    {
        (bool ok, bytes memory ret) = _settleCall(ragequit, payee, amount, label);
        assert(!ok && keccak256(ret) == keccak256(expected));
    }

    function _expectBridgeRevert(uint256[][] memory signals, bytes32 secretHash, bytes memory expected) internal {
        (bool ok, bytes memory ret) = _bridgeCall(signals, secretHash);
        assertFalse(ok, "bridge succeeded");
        assertEq(ret, expected);
    }

    function _expectSettleRevert(bool ragequit, address payee, uint256 amount, uint256 label, bytes memory expected)
        internal
    {
        (bool ok, bytes memory ret) = _settleCall(ragequit, payee, amount, label);
        assertFalse(ok, "settle succeeded");
        assertEq(ret, expected);
    }

    function _hash(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(preimage)) & type(uint248).max);
    }

    function _notes() internal pure returns (IPrivacyPoolVault.NoteData[] memory notes) {
        notes = new IPrivacyPoolVault.NoteData[](1);
        notes[0] = IPrivacyPoolVault.NoteData(bytes32(uint256(7)), hex"c0ffee");
    }

    function _proof(uint256 nullifier, uint256 change, uint256 amount)
        internal
        view
        returns (IPrivacyPoolVault.TransactProof memory proof)
    {
        proof.pubSignals = _signals(nullifier, change, amount, uint160(address(token)));
    }

    function _signals(uint256 nullifier, uint256 change, uint256 amount, uint256 tokenId)
        internal
        pure
        returns (uint256[][] memory s)
    {
        s = new uint256[][](8);
        for (uint256 i; i < 8; ++i) {
            s[i] = new uint256[](1);
        }
        s[0][0] = nullifier;
        s[1][0] = change;
        s[5][0] = amount;
        s[6][0] = tokenId;
    }
}
