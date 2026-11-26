// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";
import {FreezableERC20, SurchargeERC20} from "./mocks/PayoutERC20s.sol";

/// Settles through Aztec's real Outbox, with its membership proofs and per-epoch nullifier bitmap,
/// where the capturing fake accepts anything any number of times. The rollup is a bare address: the
/// one party allowed to insert a root.
///
/// The proven epoch holds four leaves for `portal`: `[alice's ragequit of 200 under LABEL, bob's
/// public exit of 300, 0, 0]`. The reserve comes from a real bridge, so `grossAccepted` covers it.
contract SettleRealOutboxTest is PortalFixture {
    uint256 internal constant CHECKPOINTS = 3;
    uint256 internal constant RESERVE = 10_000;
    uint256 internal constant LABEL = 11;
    Epoch internal constant EPOCH = Epoch.wrap(7);

    address internal rollup = makeAddr("rollup");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    Outbox internal real;
    bytes32 internal aliceLeaf;
    bytes32 internal bobLeaf;
    bytes32 internal emptyPair;
    bytes32 internal root;

    function setUp() public {
        real = new Outbox(rollup, VERSION);
        _deployWith(type(uint128).max, address(real));
        _bridge(portal, RESERVE);
        aliceLeaf = _leaf(portal, BridgeMessageV1.ragequitContentPreimage(alice, 200, LABEL));
        bobLeaf = _leaf(portal, BridgeMessageV1.exitContentPreimage(bob, 300));
        emptyPair = _parent(bytes32(0), bytes32(0));
        root = _parent(_parent(aliceLeaf, bobLeaf), emptyPair);
        _insert(EPOCH, CHECKPOINTS, root);
    }

    function test_eachTicketPaysOnce() public {
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(alice, 200, LABEL, EPOCH, 4);
        portal.settleRagequit(alice, 200, LABEL, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(bob, 300, 0, EPOCH, 5);
        portal.settlePublicExit(bob, 300, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 4));
        portal.settleRagequit(alice, 200, LABEL, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 5));
        portal.settlePublicExit(bob, 300, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertPaid(200, 300);
    }

    /// A longer proof of the same epoch fills a padding leaf, so the same messages sit at the same
    /// positions under a different root. A spent ticket stays spent under either.
    function test_extendingRoot_doesNotReopenASpentTicket() public {
        portal.settleRagequit(alice, 200, LABEL, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        bytes32 grownPair = _parent(_leaf(portal, BridgeMessageV1.exitContentPreimage(makeAddr("carol"), 50)), 0);
        bytes32 grownRoot = _parent(_parent(aliceLeaf, bobLeaf), grownPair);
        _insert(EPOCH, CHECKPOINTS + 1, grownRoot);

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 4));
        portal.settleRagequit(alice, 200, LABEL, EPOCH, CHECKPOINTS + 1, 0, _path(bobLeaf, grownPair));
        // Bob's settle under the longer proof shows alice's replay path was a valid one.
        portal.settlePublicExit(bob, 300, EPOCH, CHECKPOINTS + 1, 1, _path(aliceLeaf, grownPair));
        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, EPOCH, 5));
        portal.settlePublicExit(bob, 300, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertPaid(200, 300);
    }

    /// The same exit twice is two tickets, whether at two leaves of one epoch or in two epochs: each
    /// pays and emits its own `(epoch, leafId)`, and neither can be settled again.
    function test_identicalExits_areDistinctTickets() public {
        Epoch twin = Epoch.wrap(8);
        _insert(twin, 1, root);
        Epoch pair = Epoch.wrap(9);
        _insert(pair, 1, _parent(_parent(aliceLeaf, aliceLeaf), emptyPair));

        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(alice, 200, LABEL, EPOCH, 4);
        portal.settleRagequit(alice, 200, LABEL, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(alice, 200, LABEL, twin, 4);
        portal.settleRagequit(alice, 200, LABEL, twin, 1, 0, _path(bobLeaf, emptyPair));
        vm.expectEmit(address(portal));
        emit ProcessorPortalImpl.ExitSettled(alice, 200, LABEL, pair, 5);
        portal.settleRagequit(alice, 200, LABEL, pair, 1, 1, _path(aliceLeaf, emptyPair));
        portal.settleRagequit(alice, 200, LABEL, pair, 1, 0, _path(aliceLeaf, emptyPair));

        vm.expectRevert(abi.encodeWithSelector(Errors.Outbox__AlreadyNullified.selector, twin, 4));
        portal.settleRagequit(alice, 200, LABEL, twin, 1, 0, _path(bobLeaf, emptyPair));
        _assertPaid(800, 0);
    }

    /// The tag in each preimage keeps a ragequit from settling as a public exit and the reverse.
    function test_ragequitAndPublicExitDoNotCross() public {
        _expectInvalidRoot(_leaf(portal, BridgeMessageV1.exitContentPreimage(alice, 200)), bobLeaf, 0);
        portal.settlePublicExit(alice, 200, EPOCH, CHECKPOINTS, 0, _path(bobLeaf, emptyPair));
        _expectInvalidRoot(_leaf(portal, BridgeMessageV1.ragequitContentPreimage(bob, 300, 1)), aliceLeaf, 1);
        portal.settleRagequit(bob, 300, 1, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        _assertPaid(0, 0);
        assertFalse(real.hasMessageBeenConsumedAtEpoch(EPOCH, 4));
        assertFalse(real.hasMessageBeenConsumedAtEpoch(EPOCH, 5));
    }

    /// The message names its portal, so a proof for one clone cannot drain another's reserve.
    function test_anotherClonesProofIsUseless() public {
        PlainERC20 rich = new PlainERC20("Rich", "RICH");
        rich.mint(address(vault), 1 << 200);
        ProcessorPortalImpl other = ProcessorPortalImpl(factory.createPortal(address(rich)));
        _bridge(other, RESERVE);

        _expectInvalidRoot(_leaf(other, BridgeMessageV1.exitContentPreimage(bob, 300)), aliceLeaf, 1);
        other.settlePublicExit(bob, 300, EPOCH, CHECKPOINTS, 1, _path(aliceLeaf, emptyPair));
        assertEq(rich.balanceOf(address(other)), RESERVE, "other reserve");
        assertEq(other.totalPaid(), 0);
    }

    /// A payout that reverts takes the consumption and the count with it: the ticket stays good.
    function test_failedPayout_leavesTheTicket() public {
        FreezableERC20 t = new FreezableERC20();
        (ProcessorPortalImpl p, bytes32[] memory path) = _soleExit(t, Epoch.wrap(10));
        t.freeze(address(p), true);

        vm.expectRevert(abi.encodeWithSelector(FreezableERC20.Frozen.selector, address(p)));
        p.settlePublicExit(bob, 300, Epoch.wrap(10), 1, 0, path);
        assertFalse(real.hasMessageBeenConsumedAtEpoch(Epoch.wrap(10), 2));
        assertEq(p.totalPaid(), 0);

        t.freeze(address(p), false);
        p.settlePublicExit(bob, 300, Epoch.wrap(10), 1, 0, path);
        assertEq(t.balanceOf(bob), 300);
        assertTrue(real.hasMessageBeenConsumedAtEpoch(Epoch.wrap(10), 2));
    }

    /// A token that debits the payer more than `amount` is refused, leaving balances, counters and
    /// the ticket as they were.
    function test_surchargePayout_isRefusedAndLeavesTheTicket() public {
        SurchargeERC20 t = new SurchargeERC20();
        (ProcessorPortalImpl p, bytes32[] memory path) = _soleExit(t, Epoch.wrap(11));
        uint256 held = t.balanceOf(address(p));

        vm.expectRevert(ProcessorPortalImpl.InexactTransfer.selector);
        p.settlePublicExit(bob, 300, Epoch.wrap(11), 1, 0, path);
        assertEq(t.balanceOf(address(p)), held);
        assertEq(t.balanceOf(bob), 0);
        assertEq(p.totalPaid(), 0);
        assertFalse(real.hasMessageBeenConsumedAtEpoch(Epoch.wrap(11), 2));
    }

    /// A clone of `t` with a bridged reserve and an epoch whose two-leaf tree holds bob's exit of 300.
    function _soleExit(IERC20 t, Epoch epoch) internal returns (ProcessorPortalImpl p, bytes32[] memory path) {
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", address(vault), 1 << 200));
        assertTrue(ok);
        p = ProcessorPortalImpl(factory.createPortal(address(t)));
        _bridge(p, RESERVE);
        bytes32 leaf = _leaf(p, BridgeMessageV1.exitContentPreimage(bob, 300));
        _insert(epoch, 1, _parent(leaf, 0));
        path = new bytes32[](1);
    }

    function _leaf(ProcessorPortalImpl on, bytes memory preimage) internal view returns (bytes32) {
        return Hash.sha256ToField(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(HUB, VERSION),
                recipient: DataStructures.L1Actor(address(on), block.chainid),
                content: Hash.sha256ToField(preimage)
            })
        );
    }

    function _parent(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return Hash.sha256ToField(bytes.concat(left, right));
    }

    function _path(bytes32 sibling, bytes32 uncle) internal pure returns (bytes32[] memory path) {
        path = new bytes32[](2);
        path[0] = sibling;
        path[1] = uncle;
    }

    /// For a leaf presented at position 0 or 1 of the first epoch's tree.
    function _expectInvalidRoot(bytes32 leaf, bytes32 sibling, uint256 index) internal {
        bytes32 pair = index == 0 ? _parent(leaf, sibling) : _parent(sibling, leaf);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.MerkleLib__InvalidRoot.selector, root, _parent(pair, emptyPair), leaf, index)
        );
    }

    /// Roots are hashed before this is called: sha256 is a precompile call and would take the prank.
    function _insert(Epoch epoch, uint256 checkpoints, bytes32 r) internal {
        vm.prank(rollup);
        real.insert(epoch, checkpoints, r);
    }

    function _assertPaid(uint256 toAlice, uint256 toBob) internal view {
        assertEq(token.balanceOf(alice), toAlice, "alice");
        assertEq(token.balanceOf(bob), toBob, "bob");
        assertEq(token.balanceOf(address(portal)), RESERVE - toAlice - toBob, "reserve");
        assertEq(portal.totalPaid(), toAlice + toBob, "totalPaid");
    }
}
