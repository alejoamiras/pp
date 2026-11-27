// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";
import {CapturingInbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {MockPoolVault} from "./mocks/MockPoolVault.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// Two clones on Aztec's real Outbox, with the handler as the rollup. The walk bridges through every
/// vault mode, donates, flips the entry pause, settles honest exits, settles exits under forged roots
/// and replays settled tickets. Each forged root goes into a fresh epoch, so it never overwrites an
/// honest one: a rollup that could do that is Aztec's trust boundary, not the portal's.
///
/// Every property is checked on real balances, per payee. One invariant function means one campaign.
/// Each run appends its counts in `afterInvariant`, and `scripts/check-invariant.sh` requires the
/// campaign totals of Outbox-refused replays, landed forged payouts, cap hits, reserve hits and guard
/// hits to be non-zero, so a walk that never reaches a property cannot pass for one that holds it.
contract ProcessorPortalInvariantTest is Test {
    string internal constant STATS_DIR = "out/invariant-stats";
    string internal constant STATS = "out/invariant-stats/ProcessorPortalInvariant.csv";
    /// Lets a gate give each invocation its own file, so concurrent runs cannot lend each other counts.
    string internal constant STATS_ENV = "PORTAL_INVARIANT_STATS";

    PortalHandler internal handler;

    function setUp() public {
        handler = new PortalHandler();
        targetContract(address(handler));
        bytes4[] memory actions = new bytes4[](6);
        actions[0] = PortalHandler.bridge.selector;
        actions[1] = PortalHandler.donate.selector;
        actions[2] = PortalHandler.flipPause.selector;
        actions[3] = PortalHandler.settleHonest.selector;
        actions[4] = PortalHandler.settleForged.selector;
        actions[5] = PortalHandler.replay.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: actions}));
    }

    function invariant_portalNeverPaysMoreThanItAccepted() public view {
        for (uint256 i; i < 2; ++i) {
            ProcessorPortalImpl p = handler.clone(i);
            PlainERC20 t = handler.token(i);
            uint256 gross = p.grossAccepted();
            uint256 paid = p.totalPaid();
            assertLe(paid, gross, "paid past accepted");
            assertLe(gross, handler.CAP(), "accepted past the cap");
            assertEq(t.balanceOf(address(p)), gross - paid + handler.donated(i), "holdings drifted");
            assertEq(handler.receivedBy(i), paid, "payees and totalPaid disagree");
            for (uint256 k; k < 3; ++k) {
                assertEq(t.balanceOf(handler.payee(k)), handler.owed(i, k), "a payout reached the wrong payee");
            }
            assertLe(
                handler.receivedBy(i),
                handler.VAULT_START() - t.balanceOf(address(handler.vault())),
                "payees received more than the vault paid in"
            );
        }
        assertEq(handler.inbox().sent(), 2 + handler.bridges(), "messages and successful bridges disagree");
        assertEq(handler.doublePaid(), 0, "a ticket paid twice");
        assertEq(handler.honestRefusedUnexpectedly(), 0, "an honest exit was refused other than for a drained reserve");
        assertEq(handler.reentryNotGuarded(), 0, "a reentrant settle got past the guard");
    }

    function afterInvariant() external {
        vm.createDir(STATS_DIR, true);
        vm.writeLine(vm.envOr(STATS_ENV, STATS), handler.statsLine());
    }
}

contract PortalHandler is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    uint256 internal constant VERSION = 4242;
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant ROLLUP = address(0x7011);
    bytes32 internal constant SECRET_HASH = bytes32(uint256(0x5EC2E7));
    uint256 public constant CAP = 1_000_000;
    uint256 public constant VAULT_START = 1 << 128;

    struct Ticket {
        uint8 clone;
        bool ragequit;
        address payee;
        uint256 amount;
        uint256 label;
        Epoch epoch;
    }

    CapturingInbox public inbox;
    Outbox public outbox;
    MockPoolVault public vault;
    PortalFactory public factory;
    PlainERC20[2] internal tokens;
    ProcessorPortalImpl[2] internal clones;
    address[3] internal payees = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    Ticket[] internal tickets;

    uint256[2] public donated;
    uint256[2] internal honestPaid;
    uint256[3][2] public owed;
    uint256 internal nullifiers;
    uint256 internal epochs;

    uint256 public bridges;
    uint256 public doublePaid;
    uint256 public honestRefusedUnexpectedly;
    uint256 public reentryNotGuarded;
    uint256 internal calls;
    uint256 internal reverts;
    uint256 internal replays;
    uint256 internal forgedLanded;
    uint256 internal capHits;
    uint256 internal reserveHits;
    uint256 internal guardHits;

    constructor() {
        inbox = new CapturingInbox();
        outbox = new Outbox(ROLLUP, VERSION);
        IRegistry registry =
            IRegistry(address(new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))))));
        vault = new MockPoolVault();
        factory = new PortalFactory(registry, HUB, IPrivacyPoolVault(address(vault)), CAP, GUARDIAN);
        for (uint256 i; i < 2; ++i) {
            tokens[i] = new PlainERC20(i == 0 ? "A" : "B", i == 0 ? "A" : "B");
            tokens[i].mint(address(vault), VAULT_START);
            clones[i] = ProcessorPortalImpl(factory.createPortal(address(tokens[i])));
        }
        PlainERC20 stray = new PlainERC20("Stray", "STR");
        stray.mint(address(vault), VAULT_START);
        vault.setOtherToken(stray);
        vault.setReentry(
            abi.encodeCall(ProcessorPortalImpl.settlePublicExit, (payees[0], 1, Epoch.wrap(0), 1, 0, new bytes32[](1)))
        );
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(false);
    }

    /// One call in four runs a failing vault mode. Amounts of an eighth to a half of the cap reach it
    /// within a run: the fuzzer favours edge values, and small ones alone would rarely get there.
    function bridge(uint256 seed, uint256 amount, uint256 modeSeed) external {
        calls++;
        uint256 i = seed % 2;
        amount = bound(amount, CAP / 8, CAP / 2);
        MockPoolVault.Mode m =
            modeSeed % 4 == 0 ? MockPoolVault.Mode(1 + (modeSeed / 4) % 6) : MockPoolVault.Mode.Honest;
        vault.setMode(m, 1);
        IPrivacyPoolVault.TransactProof memory proof;
        uint256 n = ++nullifiers;
        uint256 context = vault.contextOf(
            IPrivacyPoolVault.TransactParams(
                address(clones[i]), abi.encode(BridgeMessageV1.PP_BRIDGE_DATA_V1, SECRET_HASH)
            ),
            _notes()
        );
        proof.pubSignals = _signals(n, n + 1, amount, uint160(address(tokens[i])), context);
        try clones[i].bridgeFromPool(proof, _notes(), SECRET_HASH) {
            bridges++;
            if (m == MockPoolVault.Mode.Reenter) reentryNotGuarded++;
        } catch (bytes memory err) {
            reverts++;
            bytes4 sel = bytes4(err);
            if (sel == ProcessorPortalImpl.CapExceeded.selector) capHits++;
            if (m == MockPoolVault.Mode.Reenter) {
                if (sel == ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector) {
                    guardHits++;
                } else if (
                    sel != ProcessorPortalImpl.EntriesPaused.selector && sel != ProcessorPortalImpl.CapExceeded.selector
                ) {
                    reentryNotGuarded++;
                }
            }
        }
        vault.setMode(MockPoolVault.Mode.Honest, 0);
    }

    function donate(uint256 seed, uint256 amount) external {
        calls++;
        uint256 i = seed % 2;
        amount = bound(amount, 0, 1000);
        tokens[i].mint(address(clones[i]), amount);
        donated[i] += amount;
    }

    function flipPause(bool paused) external {
        calls++;
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(paused);
    }

    /// An exit the hub would really emit: backed by bridged funds that no honest exit has taken yet.
    function settleHonest(uint256 seed, uint256 payeeSeed, uint256 amount, bool ragequit, uint256 label) external {
        calls++;
        uint256 i = seed % 2;
        uint256 claimable = clones[i].grossAccepted() - honestPaid[i];
        if (claimable == 0) return;
        amount = bound(amount, 1, claimable);
        uint256 k = payeeSeed % 3;
        uint256 outstanding = clones[i].grossAccepted() - clones[i].totalPaid();
        (bool ok, bytes memory err) = _publishAndSettle(i, ragequit, payees[k], amount, label);
        if (ok) {
            honestPaid[i] += amount;
            owed[i][k] += amount;
        } else {
            reverts++;
            // Only forged payouts can leave less than an honest exit is owed, and only the reserve check
            // may then refuse it, for exactly that shortfall.
            bytes memory shortfall =
                abi.encodeWithSelector(ProcessorPortalImpl.ExceedsReserve.selector, outstanding, amount);
            if (amount > outstanding && keccak256(err) == keccak256(shortfall)) reserveHits++;
            else honestRefusedUnexpectedly++;
        }
    }

    /// An exit no bridge backs, under a root the handler forges as the rollup.
    function settleForged(uint256 seed, uint256 payeeSeed, uint256 amount, bool ragequit, uint256 label) external {
        calls++;
        uint256 i = seed % 2;
        amount = bound(amount, 1, 2 * CAP);
        uint256 k = payeeSeed % 3;
        (bool ok, bytes memory err) = _publishAndSettle(i, ragequit, payees[k], amount, label);
        if (ok) {
            forgedLanded++;
            owed[i][k] += amount;
        } else {
            reverts++;
            if (bytes4(err) == ProcessorPortalImpl.ExceedsReserve.selector) reserveHits++;
        }
    }

    function replay(uint256 seed) external {
        calls++;
        if (tickets.length == 0) return;
        Ticket memory t = tickets[seed % tickets.length];
        (bool ok, bytes memory err) = _settle(t);
        if (ok) {
            doublePaid++;
        } else {
            reverts++;
            // A drained reserve refuses first; only the Outbox's own refusal shows the ticket is spent.
            if (bytes4(err) == Errors.Outbox__AlreadyNullified.selector) replays++;
        }
    }

    function clone(uint256 i) external view returns (ProcessorPortalImpl) {
        return clones[i];
    }

    function token(uint256 i) external view returns (PlainERC20) {
        return tokens[i];
    }

    function payee(uint256 k) external view returns (address) {
        return payees[k];
    }

    function receivedBy(uint256 i) external view returns (uint256 sum) {
        for (uint256 k; k < 3; ++k) {
            sum += tokens[i].balanceOf(payees[k]);
        }
    }

    /// `replays,forgedLanded,capHits,reserveHits,guardHits,calls,reverts`, one line per run.
    function statsLine() external view returns (string memory) {
        return string.concat(
            vm.toString(replays),
            ",",
            vm.toString(forgedLanded),
            ",",
            vm.toString(capHits),
            ",",
            vm.toString(reserveHits),
            ",",
            vm.toString(guardHits),
            ",",
            vm.toString(calls),
            ",",
            vm.toString(reverts)
        );
    }

    /// Publishes a one-message tree for clone `i` in a fresh epoch, then settles it and records the
    /// ticket if it paid.
    function _publishAndSettle(uint256 i, bool ragequit, address payee, uint256 amount, uint256 label)
        internal
        returns (bool ok, bytes memory err)
    {
        label = ragequit ? bound(label, 1, P - 1) : 0;
        bytes memory preimage = ragequit
            ? BridgeMessageV1.ragequitContentPreimage(payee, amount, label)
            : BridgeMessageV1.exitContentPreimage(payee, amount);
        bytes32 leaf = Hash.sha256ToField(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(HUB, VERSION),
                recipient: DataStructures.L1Actor(address(clones[i]), block.chainid),
                content: Hash.sha256ToField(preimage)
            })
        );
        bytes32 root = Hash.sha256ToField(bytes.concat(leaf, bytes32(0)));
        Ticket memory t = Ticket(uint8(i), ragequit, payee, amount, label, Epoch.wrap(++epochs));
        vm.prank(ROLLUP);
        outbox.insert(t.epoch, 1, root);
        (ok, err) = _settle(t);
        if (ok) tickets.push(t);
    }

    function _settle(Ticket memory t) internal returns (bool, bytes memory) {
        bytes32[] memory path = new bytes32[](1);
        return address(clones[t.clone])
            .call(
                t.ragequit
                    ? abi.encodeCall(
                        ProcessorPortalImpl.settleRagequit, (t.payee, t.amount, t.label, t.epoch, 1, 0, path)
                    )
                    : abi.encodeCall(ProcessorPortalImpl.settlePublicExit, (t.payee, t.amount, t.epoch, 1, 0, path))
            );
    }

    function _notes() internal pure returns (IPrivacyPoolVault.NoteData[] memory notes) {
        notes = new IPrivacyPoolVault.NoteData[](1);
        notes[0] = IPrivacyPoolVault.NoteData(bytes32(uint256(7)), hex"c0ffee");
    }

    function _signals(uint256 nullifier, uint256 change, uint256 amount, uint256 tokenId, uint256 context)
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
        s[7][0] = context;
    }
}
