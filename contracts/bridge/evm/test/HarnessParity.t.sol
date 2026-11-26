// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@oz/proxy/Clones.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {ProcessorPortalHarness} from "./harness/ProcessorPortalHarness.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";
import {MockPoolVault} from "./mocks/MockPoolVault.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The symbolic proofs run on `ProcessorPortalHarness`. Here a harness clone and a production clone
/// take the same calls and must agree on everything but the content hash: success, revert data,
/// holdings, counters, payouts and message counts. Each clone has its own vault, since the mock
/// spends a nullifier once, and each proof's context is computed for its own clone. The controls
/// succeed on both, so a revert the two share cannot pass for agreement.
contract HarnessParityTest is PortalFixture {
    uint256 internal constant CAP = 1 << 127;
    uint256 internal constant SEED = 1 << 100;

    MockPoolVault internal twinVault;
    ProcessorPortalImpl internal twin;
    PlainERC20 internal other;

    struct Spend {
        uint256 nullifier;
        uint256 change;
        uint256 amount;
        uint256 tokenId;
        bytes32 secretHash;
    }

    struct Outcome {
        bool ok;
        bytes revertData;
        uint256 held;
        uint256 gross;
        uint256 paid;
        uint256 delivered;
        uint256 messages;
    }

    function setUp() public {
        _deploy(CAP);
        twinVault = new MockPoolVault();
        token.mint(address(twinVault), 1 << 200);
        vm.prank(address(factory));
        ProcessorPortalHarness harness =
            new ProcessorPortalHarness(registry, HUB, IPrivacyPoolVault(address(twinVault)), CAP);
        twin = ProcessorPortalImpl(
            Clones.cloneDeterministicWithImmutableArgs(address(harness), abi.encodePacked(address(token)), bytes32(0))
        );

        other = new PlainERC20("Oth", "OTH");
        bytes memory reentry = abi.encodeCall(
            ProcessorPortalImpl.settlePublicExit, (address(0xBEEF), 1, Epoch.wrap(1), 1, 0, new bytes32[](0))
        );
        MockPoolVault[2] memory vaults = [vault, twinVault];
        for (uint256 i; i < 2; ++i) {
            other.mint(address(vaults[i]), 1 << 200);
            vaults[i].setOtherToken(other);
            vaults[i].setReentry(reentry);
        }

        Spend memory seed = Spend(1, 2, SEED, uint160(address(token)), SECRET_HASH);
        assertTrue(_bridge(portal, seed).ok && _bridge(twin, seed).ok, "seed bridge");
    }

    function test_controls_bridgeAndBothSettlesSucceedOnBoth() public {
        Spend memory s = Spend(7, 8, 1000, uint160(address(token)), SECRET_HASH);
        Outcome memory a = _bridge(portal, s);
        Outcome memory b = _bridge(twin, s);
        assertTrue(a.ok && b.ok, "bridge control");
        assertEq(a.messages, 1);
        _assertSame(a, b);

        a = _settle(portal, true, address(0xBEEF), 600, 1);
        b = _settle(twin, true, address(0xBEEF), 600, 1);
        assertTrue(a.ok && b.ok, "ragequit control");
        assertEq(a.delivered, 600);
        assertEq(a.messages, 1);
        _assertSame(a, b);

        a = _settle(portal, false, address(0xBEEF), 400, 0);
        b = _settle(twin, false, address(0xBEEF), 400, 0);
        assertTrue(a.ok && b.ok, "public exit control");
        assertEq(a.delivered, 400);
        _assertSame(a, b);
    }

    /// Bounds put each range edge (0, P, 2^128, the cap) and every vault mode within reach.
    function testFuzz_bridge_sameOutcome(Spend memory s, bool otherToken, uint8 mode, uint256 delta, bool paused)
        public
    {
        s.nullifier = bound(s.nullifier, 0, P);
        s.change = bound(s.change, 0, P);
        s.amount = bound(s.amount, 0, 1 << 128);
        s.secretHash = bytes32(bound(uint256(s.secretHash), 0, P));
        s.tokenId = uint160(address(otherToken ? other : token));
        MockPoolVault.Mode m = MockPoolVault.Mode(bound(mode, 0, uint8(type(MockPoolVault.Mode).max)));
        delta = bound(delta, 1, 3);
        vault.setMode(m, delta);
        twinVault.setMode(m, delta);
        _pause(paused);

        _assertSame(_bridge(portal, s), _bridge(twin, s));
    }

    function testFuzz_settle_sameOutcome(
        bool ragequit,
        bool toSelf,
        address payee,
        uint256 amount,
        uint256 label,
        uint256 donation,
        bool paused
    ) public {
        vm.assume(payee != address(portal) && payee != address(twin));
        amount = bound(amount, 0, SEED + 2);
        label = bound(label, 0, P);
        donation = bound(donation, 0, 2);
        token.mint(address(portal), donation);
        token.mint(address(twin), donation);
        _pause(paused);

        _assertSame(
            _settle(portal, ragequit, toSelf ? address(portal) : payee, amount, label),
            _settle(twin, ragequit, toSelf ? address(twin) : payee, amount, label)
        );
    }

    function _bridge(ProcessorPortalImpl on, Spend memory s) internal returns (Outcome memory o) {
        IPrivacyPoolVault.TransactProof memory proof;
        uint256 context = _context(address(on), abi.encode(BridgeMessageV1.PP_BRIDGE_DATA_V1, s.secretHash), _notes());
        proof.pubSignals = _signals(s.nullifier, s.change, s.amount, s.tokenId, context);
        uint256 sent = inbox.sent();
        (o.ok, o.revertData) =
            address(on).call(abi.encodeCall(ProcessorPortalImpl.bridgeFromPool, (proof, _notes(), s.secretHash)));
        // A success returns the Inbox key, which hashes the content: the one thing meant to differ.
        if (o.ok) delete o.revertData;
        o.messages = inbox.sent() - sent;
        _record(on, o);
    }

    function _settle(ProcessorPortalImpl on, bool ragequit, address payee, uint256 amount, uint256 label)
        internal
        returns (Outcome memory o)
    {
        bytes32 last = keccak256(abi.encode(outbox.lastMsg()));
        uint256 before = token.balanceOf(payee);
        bytes memory data = ragequit
            ? abi.encodeCall(
                ProcessorPortalImpl.settleRagequit, (payee, amount, label, Epoch.wrap(1), 1, 0, new bytes32[](0))
            )
            : abi.encodeCall(
                ProcessorPortalImpl.settlePublicExit, (payee, amount, Epoch.wrap(1), 1, 0, new bytes32[](0))
            );
        (o.ok, o.revertData) = address(on).call(data);
        // The fake Outbox keeps the last message consumed, and each clone consumes as its own recipient.
        o.messages = keccak256(abi.encode(outbox.lastMsg())) == last ? 0 : 1;
        o.delivered = token.balanceOf(payee) - before;
        _record(on, o);
    }

    function _record(ProcessorPortalImpl on, Outcome memory o) internal view {
        o.held = token.balanceOf(address(on));
        o.gross = on.grossAccepted();
        o.paid = on.totalPaid();
    }

    function _assertSame(Outcome memory a, Outcome memory b) internal pure {
        assertEq(a.ok, b.ok, "success");
        assertEq(a.revertData, b.revertData, "revert data");
        assertEq(a.held, b.held, "held");
        assertEq(a.gross, b.gross, "grossAccepted");
        assertEq(a.paid, b.paid, "totalPaid");
        assertEq(a.delivered, b.delivered, "delivered");
        assertEq(a.messages, b.messages, "messages");
    }

    function _pause(bool paused) internal {
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(paused);
    }
}
