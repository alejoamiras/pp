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
///
/// halmos passes any path that reverts, so each call sits in a try whose catch fails the proof: valid
/// inputs must succeed, which is what makes "in either pause state" a claim and not a vacuity.
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
        IRegistry registry = IRegistry(address(new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))))));
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

    /// The harness binds to the real factory, so its pause is the one the proofs flip.
    function test_canary_harnessReadsTheFactory() public view {
        assertEq(address(harness.FACTORY()), address(factory));
        assertEq(address(clone.underlying()), address(token));
        assertEq(clone.grossAccepted(), SEED);
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
        uint256[][] memory s = new uint256[][](8);
        for (uint256 i; i < 8; ++i) {
            s[i] = new uint256[](1);
        }
        s[0][0] = nullifier;
        s[1][0] = change;
        s[5][0] = amount;
        s[6][0] = uint160(address(token));
        proof.pubSignals = s;
    }
}
