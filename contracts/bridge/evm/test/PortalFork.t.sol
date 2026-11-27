// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../src/libraries/BridgeMessageV1.sol";

/// The bridge's L1 side against a live Sepolia pool (the runner's target) and the Aztec testnet Inbox, on the
/// fork that `packages/sepolia-fork` prepared: an approved USDC note, a fresh factory and portal, and one spend
/// proved to that portal. Only that runner runs it, with the fixture at `PP_FORK_FIXTURE`; hermetic gates skip `Fork`.
/// Expected errors are the pool's at the commit pp-env pins, so a deployed vault that differs fails by name.
contract PortalForkTest is Test {
    uint256 internal constant SEPOLIA = 11_155_111;
    bytes4 internal constant INVALID_PROCESSOR = bytes4(keccak256("PoolVault_InvalidProcessor()"));
    bytes4 internal constant CONTEXT_MISMATCH = bytes4(keccak256("PoolVault_ProofContextMismatch()"));
    bytes4 internal constant INVALID_PROOF = bytes4(keccak256("PoolVault_InvalidTransactProof()"));
    /// "USDC" as the factory stores a metadata string: a zero byte, then the sanitized text, zero-padded.
    bytes32 internal constant USDC_WORD = hex"0055534443";
    uint256 internal constant NULLIFIERS = 0;
    uint256 internal constant COMMITMENTS = 1;
    uint256 internal constant AMOUNT_OUT = 5;

    string internal fixture;
    PortalFactory internal factory;
    ProcessorPortalImpl internal portal;
    IERC20 internal usdc;
    IPrivacyPoolVault internal vault;
    IInbox internal inbox;
    bytes32 internal secretHash;
    bytes32 internal otherSecretHash;

    function setUp() public {
        fixture = vm.readFile(vm.envString("PP_FORK_FIXTURE"));
        factory = PortalFactory(vm.parseJsonAddress(fixture, ".factory"));
        portal = ProcessorPortalImpl(vm.parseJsonAddress(fixture, ".portal"));
        usdc = IERC20(vm.parseJsonAddress(fixture, ".usdc"));
        vault = IPrivacyPoolVault(vm.parseJsonAddress(fixture, ".vault"));
        inbox = IInbox(vm.parseJsonAddress(fixture, ".inbox"));
        secretHash = vm.parseJsonBytes32(fixture, ".secretHash");
        otherSecretHash = vm.parseJsonBytes32(fixture, ".otherSecretHash");
    }

    function _proof() internal view returns (IPrivacyPoolVault.TransactProof memory p) {
        uint256[] memory a = vm.parseJsonUintArray(fixture, ".pA");
        uint256[] memory b0 = vm.parseJsonUintArray(fixture, ".pB0");
        uint256[] memory b1 = vm.parseJsonUintArray(fixture, ".pB1");
        uint256[] memory c = vm.parseJsonUintArray(fixture, ".pC");
        p.pA = [a[0], a[1]];
        p.pB = [[b0[0], b0[1]], [b1[0], b1[1]]];
        p.pC = [c[0], c[1]];
        // A 1x1 spend: eight rows of one word each, in the vault's row order.
        uint256[] memory s = vm.parseJsonUintArray(fixture, ".signals");
        p.pubSignals = new uint256[][](s.length);
        for (uint256 i = 0; i < s.length; i++) {
            p.pubSignals[i] = new uint256[](1);
            p.pubSignals[i][0] = s[i];
        }
    }

    function _noteData() internal view returns (IPrivacyPoolVault.NoteData[] memory notes) {
        bytes32[] memory hints = vm.parseJsonBytes32Array(fixture, ".noteHints");
        bytes[] memory data = vm.parseJsonBytesArray(fixture, ".noteData");
        notes = new IPrivacyPoolVault.NoteData[](hints.length);
        for (uint256 i = 0; i < hints.length; i++) {
            notes[i] = IPrivacyPoolVault.NoteData(hints[i], data[i]);
        }
    }

    function _expectedKey(IPrivacyPoolVault.TransactProof memory p, uint256 index) internal view returns (bytes32) {
        bytes32 content = Hash.sha256ToField(
            BridgeMessageV1.bridgeContentPreimage(
                p.pubSignals[NULLIFIERS][0], p.pubSignals[COMMITMENTS][0], p.pubSignals[AMOUNT_OUT][0]
            )
        );
        return Hash.sha256ToField(
            DataStructures.L1ToL2Msg({
                sender: DataStructures.L1Actor(address(portal), SEPOLIA),
                recipient: DataStructures.L2Actor(portal.L2_HUB(), portal.ROLLUP_VERSION()),
                content: content,
                secretHash: secretHash,
                index: index
            })
        );
    }

    /// The deployed vault's ABI and signal layout, the live entry config, and the real testnet registry,
    /// Inbox and version: one spend pays the portal exactly and sends the message key derived here.
    function testFork_bridgeFromPool() public {
        assertEq(block.chainid, SEPOLIA, "the fork serves Sepolia");
        IPortalFactory.Registration memory reg = factory.registrationOf(address(usdc));
        assertEq(reg.portal, address(portal), "registration names the portal");
        assertEq(reg.decimals, 6, "USDC decimals");
        assertEq(reg.nameWord, USDC_WORD, "USDC name");
        assertEq(reg.symbolWord, USDC_WORD, "USDC symbol");
        assertEq(address(portal.INBOX()), address(inbox), "the portal's Inbox is the registry's");
        assertEq(address(portal.POOL()), address(vault), "the portal's pool is the pinned vault");

        IPrivacyPoolVault.TransactProof memory p = _proof();
        uint256 amount = p.pubSignals[AMOUNT_OUT][0];
        uint256 index = inbox.getTotalMessagesInserted();
        uint256 before = usdc.balanceOf(address(portal));
        bytes32 expected = _expectedKey(p, index);

        vm.recordLogs();
        (bytes32 key, uint256 leafIndex) = portal.bridgeFromPool(p, _noteData(), secretHash);

        assertEq(usdc.balanceOf(address(portal)) - before, amount, "exact payment");
        assertEq(portal.grossAccepted(), amount, "grossAccepted");
        assertEq(leafIndex, index, "leaf index is the Inbox's count before the call");
        assertEq(key, expected, "key derived independently");
        _assertEvents(vm.getRecordedLogs(), p, expected, index);
    }

    /// Exactly one event from each of the Inbox and the portal; the portal's carries everything the bridge
    /// client reads back from it.
    function _assertEvents(
        Vm.Log[] memory logs,
        IPrivacyPoolVault.TransactProof memory p,
        bytes32 expected,
        uint256 index
    ) internal view {
        (uint256 sent, uint256 bridged) = (0, 0);
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(inbox)) {
                assertEq(logs[i].topics[0], IInbox.MessageSent.selector, "the Inbox emits only MessageSent");
                assertEq(logs[i].topics[1], expected, "Inbox MessageSent key");
                sent++;
            }
            if (logs[i].emitter == address(portal)) {
                assertEq(logs[i].topics[0], ProcessorPortalImpl.BridgedFromPool.selector, "the portal emits only BridgedFromPool");
                assertEq(logs[i].topics[1], expected, "BridgedFromPool key");
                assertEq(uint256(logs[i].topics[2]), p.pubSignals[NULLIFIERS][0], "BridgedFromPool nullifier");
                (uint256 leafIndex, uint256 changeCommitment, uint256 amount) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(leafIndex, index, "BridgedFromPool leaf index");
                assertEq(changeCommitment, p.pubSignals[COMMITMENTS][0], "BridgedFromPool change commitment");
                assertEq(amount, p.pubSignals[AMOUNT_OUT][0], "BridgedFromPool amount");
                bridged++;
            }
        }
        assertEq(sent, 1, "one MessageSent");
        assertEq(bridged, 1, "one BridgedFromPool");
    }

    /// The deployed vault binds `processor` into the proof and checks `msg.sender` against it.
    function testFork_spendCannotChangeProcessor() public {
        address attacker = makeAddr("attacker");
        IPrivacyPoolVault.TransactProof memory p = _proof();
        IPrivacyPoolVault.NoteData[] memory notes = _noteData();
        bytes memory data = BridgeMessageV1.bridgeData(secretHash);

        vm.prank(attacker);
        vm.expectRevert(CONTEXT_MISMATCH);
        vault.transact(p, IPrivacyPoolVault.TransactParams(attacker, data), notes);

        vm.prank(attacker);
        vm.expectRevert(INVALID_PROCESSOR);
        vault.transact(p, IPrivacyPoolVault.TransactParams(address(portal), data), notes);
    }

    /// The deployed vault's context covers `data`, so another valid secret hash cannot claim the spend.
    function testFork_secretHashIsBound() public {
        assertTrue(otherSecretHash != secretHash, "a different secret hash");
        IPrivacyPoolVault.TransactProof memory p = _proof();
        IPrivacyPoolVault.NoteData[] memory notes = _noteData();
        vm.expectRevert(CONTEXT_MISMATCH);
        portal.bridgeFromPool(p, notes, otherSecretHash);
    }

    function testFork_tamperedProofRejected() public {
        IPrivacyPoolVault.TransactProof memory p = _proof();
        IPrivacyPoolVault.NoteData[] memory notes = _noteData();
        p.pA[0] = p.pA[0] ^ 1;
        vm.expectRevert(INVALID_PROOF);
        portal.bridgeFromPool(p, notes, secretHash);
    }
}
