// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// Cross-call INVARIANT suite for the factory. A handler drives randomized create, pause and
/// ownership-handoff sequences from several actors; after every sequence:
///
///   I1  A token's portal address never changes and always equals the prediction.
///   I3  Only the current owner (the guardian, or whoever accepted a handoff) flips the entry pause,
///       it always can, and the pause equals the owner's last write.
///   I4  The factory never sends a second `register` for a token (one Inbox message per portal).
///   I5  Ownership moves only by the pending owner's accept, never by a transfer alone, and renounce
///       never succeeds, so the pause always has an owner.
///
/// Each run appends its handoff counts in `afterInvariant`, and `scripts/check-invariant.sh`
/// requires the totals to be non-zero, so a walk that never hands ownership over cannot pass for I3
/// and I5 holding across a handoff. Clone custody and the pause's effect on entries live in
/// ProcessorPortalInvariant.t.sol.
contract PortalFactoryInvariantTest is Test {
    string internal constant STATS_DIR = "out/invariant-stats";
    string internal constant STATS = "out/invariant-stats/PortalFactoryInvariant.csv";
    /// Lets a gate give each invocation its own file, so concurrent runs cannot lend each other counts.
    string internal constant STATS_ENV = "FACTORY_INVARIANT_STATS";

    FactoryHandler internal handler;

    function setUp() public {
        handler = new FactoryHandler();
        targetContract(address(handler));
    }

    function invariant_portalAddressIsStable() public view {
        for (uint256 i = 0; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            address seen = handler.firstPortal(t);
            if (seen != address(0)) {
                assertEq(handler.factory().portalOf(t), seen, "portal changed");
                assertEq(handler.factory().predictPortal(t), seen, "prediction drifted");
            }
        }
    }

    function invariant_onlyTheOwnerFlipsPause() public view {
        assertEq(handler.factory().entriesPaused(), handler.ghostEntriesPaused(), "entry pause drifted");
        assertFalse(handler.strangerPaused(), "a non-owner flipped the entry pause");
        assertFalse(handler.ownerRefused(), "the owner could not flip the entry pause");
    }

    function invariant_oneRegisterPerPortal() public view {
        assertEq(handler.inbox().sent(), handler.ghostRegisters(), "extra Inbox messages");
    }

    function invariant_ownershipMovesOnlyByAccept() public view {
        assertEq(handler.factory().owner(), handler.ghostOwner(), "the owner moved other than by an accept");
        assertEq(handler.factory().pendingOwner(), handler.ghostPending(), "the pending owner drifted");
        assertTrue(handler.factory().owner() != address(0), "ownership was cleared");
        assertEq(handler.wrongMoves(), 0, "a transfer, accept or renounce succeeded for the wrong caller");
    }

    function afterInvariant() external {
        vm.createDir(STATS_DIR, true);
        vm.writeLine(vm.envOr(STATS_ENV, STATS), handler.statsLine());
    }
}

contract FactoryHandler is StdUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PortalFactory public factory;
    CapturingInbox public inbox;
    address public guardian = address(0x6A);
    address[3] private actors = [address(0xA1), address(0xA2), address(0xA3)];

    address[] public tokens;
    mapping(address => address) public firstPortal;
    bool public ghostEntriesPaused = true;
    bool public strangerPaused;
    bool public ownerRefused;
    uint256 public ghostRegisters;

    address public ghostOwner = guardian;
    address public ghostPending;
    uint256 public wrongMoves;
    uint256 internal handoffs;
    uint256 internal newOwnerPauses;
    uint256 internal refusedTransfers;
    uint256 internal refusedAccepts;
    uint256 internal refusedRenounces;

    constructor() {
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        factory = new PortalFactory(
            IRegistry(address(registry)), bytes32(uint256(0x4B)), IPrivacyPoolVault(address(0x9001)), type(uint256).max, guardian
        );
        for (uint256 i = 0; i < 4; i++) {
            tokens.push(address(new PlainERC20("T", "T")));
        }
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function createPortal(uint256 tokenSeed, uint256 actorSeed) external {
        address t = tokens[tokenSeed % tokens.length];
        bool existed = factory.portalOf(t) != address(0);
        vm.prank(actors[actorSeed % 3]);
        address p = factory.createPortal(t);
        if (!existed) {
            firstPortal[t] = p;
            ghostRegisters++;
        }
    }

    function ownerPause(bool paused) external {
        vm.prank(ghostOwner);
        try factory.setEntriesPaused(paused) {
            ghostEntriesPaused = paused;
            if (ghostOwner != guardian) newOwnerPauses++;
        } catch {
            ownerRefused = true;
        }
    }

    function strangerPause(uint256 seed, bool paused) external {
        address who = _person(seed);
        if (who == ghostOwner) return;
        vm.prank(who);
        try factory.setEntriesPaused(paused) {
            strangerPaused = true;
        } catch {}
    }

    /// From the owner, the pending owner or anyone else, to anyone in the cast or to nobody.
    function transferOwnership(uint256 callerSeed, uint256 toSeed) external {
        address caller = _caller(callerSeed);
        address to = toSeed % 5 == 4 ? address(0) : _person(toSeed);
        vm.prank(caller);
        try factory.transferOwnership(to) {
            if (caller != ghostOwner) wrongMoves++;
            ghostPending = to;
        } catch {
            if (caller == ghostOwner) wrongMoves++;
            else refusedTransfers++;
        }
    }

    function acceptOwnership(uint256 callerSeed) external {
        address caller = _caller(callerSeed);
        vm.prank(caller);
        try factory.acceptOwnership() {
            if (caller != ghostPending) wrongMoves++;
            if (caller != ghostOwner) handoffs++;
            ghostOwner = caller;
            ghostPending = address(0);
        } catch {
            if (caller == ghostPending) wrongMoves++;
            else refusedAccepts++;
        }
    }

    function renounceOwnership(uint256 callerSeed) external {
        vm.prank(_caller(callerSeed));
        try factory.renounceOwnership() {
            wrongMoves++;
        } catch {
            refusedRenounces++;
        }
    }

    /// `handoffs,newOwnerPauses,refusedTransfers,refusedAccepts,refusedRenounces`, one line per run.
    function statsLine() external view returns (string memory) {
        return string.concat(
            vm.toString(handoffs),
            ",",
            vm.toString(newOwnerPauses),
            ",",
            vm.toString(refusedTransfers),
            ",",
            vm.toString(refusedAccepts),
            ",",
            vm.toString(refusedRenounces)
        );
    }

    function _person(uint256 seed) internal view returns (address) {
        uint256 i = seed % 4;
        return i == 3 ? guardian : actors[i];
    }

    /// The owner a third of the time, the pending owner (when there is one) a third, anyone otherwise.
    function _caller(uint256 seed) internal view returns (address) {
        if (seed % 3 == 0) return ghostOwner;
        if (seed % 3 == 1 && ghostPending != address(0)) return ghostPending;
        return _person(seed / 3);
    }
}
