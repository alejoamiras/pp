// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../../src/PortalFactory.sol";
import {ProcessorPortalImpl} from "../../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../../src/interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "../../src/libraries/BridgeMessageV1.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "../mocks/AztecFakes.sol";
import {MockPoolVault} from "../mocks/MockPoolVault.sol";
import {PlainERC20} from "../mocks/MetadataERC20s.sol";

/// One generation on the Aztec fakes and the mock vault, with entries opened by the guardian, and
/// the proofs a client would send: 1×1 spends whose context binds this portal's exact params.
abstract contract PortalFixture is Test {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    uint256 internal constant VERSION = 4242;
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    bytes32 internal constant SECRET_HASH = bytes32(uint256(0x5EC2E7));

    IRegistry internal registry;
    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    MockPoolVault internal vault;
    PortalFactory internal factory;
    PlainERC20 internal token;
    ProcessorPortalImpl internal portal;
    uint256 private nullifiers;

    function _deploy(uint256 cap) internal {
        outbox = new CapturingOutbox();
        _deployWith(cap, address(outbox));
    }

    /// The same generation with the rollup naming `outbox_`, e.g. Aztec's real Outbox.
    function _deployWith(uint256 cap, address outbox_) internal {
        inbox = new CapturingInbox();
        registry = IRegistry(address(new FakeRegistry(address(new FakeRollup(address(inbox), outbox_)))));
        vault = new MockPoolVault();
        factory = new PortalFactory(registry, HUB, IPrivacyPoolVault(address(vault)), cap, GUARDIAN);
        token = new PlainERC20("Tok", "TOK");
        token.mint(address(vault), 1 << 200);
        portal = ProcessorPortalImpl(factory.createPortal(address(token)));
        vm.prank(GUARDIAN);
        factory.setEntriesPaused(false);
    }

    function _notes() internal pure returns (IPrivacyPoolVault.NoteData[] memory notes) {
        notes = new IPrivacyPoolVault.NoteData[](1);
        notes[0] = IPrivacyPoolVault.NoteData(bytes32(uint256(7)), hex"c0ffee");
    }

    /// The context the vault requires, computed from the bytes a client proves, not from the portal.
    function _context(address processor, bytes memory data, IPrivacyPoolVault.NoteData[] memory notes)
        internal
        view
        returns (uint256)
    {
        return vault.contextOf(IPrivacyPoolVault.TransactParams(processor, data), notes);
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

    /// A valid proof for `amount` of the portal's token into `on`, with a fresh nullifier.
    function _proof(ProcessorPortalImpl on, uint256 amount, bytes32 secretHash)
        internal
        returns (IPrivacyPoolVault.TransactProof memory proof, uint256 nullifier)
    {
        nullifier = ++nullifiers;
        uint256 context = _context(address(on), abi.encode(BridgeMessageV1.PP_BRIDGE_DATA_V1, secretHash), _notes());
        proof.pubSignals = _signals(nullifier, nullifier + 1000, amount, uint160(address(on.underlying())), context);
    }

    function _bridge(ProcessorPortalImpl on, uint256 amount) internal returns (bytes32 key, uint256 index) {
        (IPrivacyPoolVault.TransactProof memory proof,) = _proof(on, amount, SECRET_HASH);
        return on.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    function _settleRagequit(ProcessorPortalImpl on, address payee, uint256 amount, uint256 label) internal {
        on.settleRagequit(payee, amount, label, Epoch.wrap(1), 1, 0, new bytes32[](0));
    }

    function _settlePublicExit(ProcessorPortalImpl on, address payee, uint256 amount) internal {
        on.settlePublicExit(payee, amount, Epoch.wrap(1), 1, 0, new bytes32[](0));
    }
}
