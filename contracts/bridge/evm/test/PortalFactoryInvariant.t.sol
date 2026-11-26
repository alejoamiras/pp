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

/// Cross-call INVARIANT suite for the factory. A handler drives randomized create and pause
/// sequences from several actors; after every sequence:
///
///   I1  A token's portal address never changes and always equals the prediction.
///   I3  Only the guardian ever flips the entry pause; it equals the guardian's last write.
///   I4  The factory never sends a second `register` for a token (one Inbox message per portal).
///
/// Clone custody and the pause's effect on entries live in ProcessorPortalInvariant.t.sol.
contract PortalFactoryInvariantTest is Test {
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

    function invariant_onlyGuardianFlipsPause() public view {
        assertEq(handler.factory().entriesPaused(), handler.ghostEntriesPaused(), "entry pause drifted");
        assertFalse(handler.strangerPaused(), "a non-guardian flipped the entry pause");
    }

    function invariant_oneRegisterPerPortal() public view {
        assertEq(handler.inbox().sent(), handler.ghostRegisters(), "extra Inbox messages");
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
    uint256 public ghostRegisters;

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

    function guardianPause(bool paused) external {
        vm.prank(guardian);
        factory.setEntriesPaused(paused);
        ghostEntriesPaused = paused;
    }

    function strangerPause(uint256 actorSeed, bool paused) external {
        vm.prank(actors[actorSeed % 3]);
        try factory.setEntriesPaused(paused) {
            strangerPaused = true;
        } catch {}
    }
}
