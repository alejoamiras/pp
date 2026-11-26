// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {ProcessorPortalImpl} from "../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {IPortalFactory} from "../src/interfaces/IPortalFactory.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {
    Bytes32MetadataERC20,
    HeadlessStringERC20,
    HugeDecimalsERC20,
    HugeNameERC20,
    NoDecimalsERC20,
    NonAsciiNameERC20,
    PlainERC20,
    ReentrantNameERC20,
    StringDecimalsERC20,
    WeirdDecimalsERC20
} from "./mocks/MetadataERC20s.sol";

contract PortalFactoryTest is Test {
    bytes32 internal constant HUB = bytes32(uint256(0x4B));
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    IPrivacyPoolVault internal constant POOL = IPrivacyPoolVault(address(0x9001));
    uint256 internal constant CAP = type(uint256).max;

    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    FakeRegistry internal registry;
    PortalFactory internal factory;
    PlainERC20 internal usdc;

    function setUp() public {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        factory = new PortalFactory(IRegistry(address(registry)), HUB, POOL, CAP, guardian);
        usdc = new PlainERC20("USD Coin", "USDC");
    }

    function word(string memory s) internal pure returns (bytes32) {
        bytes memory b = bytes(s);
        uint256 acc;
        for (uint256 i = 0; i < 31; i++) {
            acc = (acc << 8) | (i < b.length ? uint8(b[i]) : 0);
        }
        return bytes32(acc);
    }

    function registerHash(address token, address portal, bytes32 n, bytes32 s, uint8 d) internal pure returns (bytes32) {
        return Hash.sha256ToField(
            abi.encodeWithSignature("register(address,address,bytes32,bytes32,uint8)", token, portal, n, s, d)
        );
    }

    // ── The registration tuple: everything the hub will trust agrees ────────────────────────────

    function test_createPortal_registersTheWholeTuple() public {
        address predicted = factory.predictPortal(address(usdc));
        vm.expectEmit(true, true, true, true);
        emit IPortalFactory.PortalCreated(
            address(usdc), predicted, word("USD Coin"), word("USDC"), 18, keccak256(abi.encode(registerHash(address(usdc), predicted, word("USD Coin"), word("USDC"), 18), factory.REGISTER_SECRET_HASH())), 0
        );
        address portal = factory.createPortal(address(usdc));

        assertEq(portal, predicted, "clone landed at the predicted address");
        assertEq(address(ProcessorPortalImpl(portal).underlying()), address(usdc), "clone's immutable arg is the token");
        assertEq(factory.portalOf(address(usdc)), portal);
        assertEq(factory.tokenOf(portal), address(usdc));

        IPortalFactory.Registration memory r = factory.registrationOf(address(usdc));
        assertEq(r.portal, portal);
        assertEq(r.decimals, 18);
        assertEq(r.nameWord, word("USD Coin"));
        assertEq(r.symbolWord, word("USDC"));
        assertEq(r.registerIndex, 0);
        assertEq(r.registerKey, inbox.lastContentHash() == bytes32(0) ? bytes32(0) : keccak256(abi.encode(inbox.lastContentHash(), inbox.lastSecretHash())));

        assertEq(inbox.lastSender(), address(factory), "the FACTORY is the L1 actor of the register message");
        assertEq(inbox.lastBridge(), HUB, "addressed to the hub");
        assertEq(inbox.lastVersion(), 4242);
        assertEq(inbox.lastContentHash(), registerHash(address(usdc), portal, word("USD Coin"), word("USDC"), 18));
        assertEq(inbox.lastSecretHash(), factory.REGISTER_SECRET_HASH());
        assertEq(ProcessorPortalImpl(portal).L2_HUB(), HUB);
        assertEq(address(ProcessorPortalImpl(portal).FACTORY()), address(factory));
    }

    function test_createPortal_isIdempotent() public {
        address first = factory.createPortal(address(usdc));
        uint256 sentBefore = inbox.sent();
        address second = factory.createPortal(address(usdc));
        assertEq(second, first);
        assertEq(inbox.sent(), sentBefore, "no second register message");
    }

    function test_createPortal_frontRunIsIdentityPreserving() public {
        address predicted = factory.predictPortal(address(usdc));
        vm.prank(alice);
        address portal = factory.createPortal(address(usdc));
        assertEq(portal, predicted);
        assertEq(factory.registrationOf(address(usdc)).nameWord, word("USD Coin"));
    }

    // ── Metadata classification ───────────────────────────────────────────────────────

    function test_createPortal_rejectsEOA() public {
        vm.expectRevert(IPortalFactory.NotAContract.selector);
        factory.createPortal(alice);
    }

    function test_createPortal_requiresDecimals() public {
        address none = address(new NoDecimalsERC20());
        address str = address(new StringDecimalsERC20());
        address huge = address(new HugeDecimalsERC20());
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(none);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(str);
        vm.expectRevert(IPortalFactory.NoDecimals.selector);
        factory.createPortal(huge);
    }

    function test_createPortal_acceptsEveryUint8Decimals() public {
        uint8[5] memory ds = [0, 18, 19, 38, 255];
        for (uint256 i = 0; i < ds.length; i++) {
            WeirdDecimalsERC20 t = new WeirdDecimalsERC20(ds[i]);
            factory.createPortal(address(t));
            assertEq(factory.registrationOf(address(t)).decimals, ds[i]);
        }
    }

    function test_createPortal_readsBytes32Metadata() public {
        Bytes32MetadataERC20 mkr = new Bytes32MetadataERC20();
        factory.createPortal(address(mkr));
        IPortalFactory.Registration memory r = factory.registrationOf(address(mkr));
        assertEq(r.nameWord, word("Maker"));
        assertEq(r.symbolWord, word("MKR"));
    }

    function test_createPortal_sanitizesNonAscii() public {
        NonAsciiNameERC20 t = new NonAsciiNameERC20();
        factory.createPortal(address(t));
        IPortalFactory.Registration memory r = factory.registrationOf(address(t));
        // "Nülo€" is N, 2 bytes, l, o, 3 bytes → every non-ASCII byte becomes `_`.
        assertEq(r.nameWord, word("N__lo___"));
        assertEq(r.symbolWord, word("N___"));
    }

    function test_createPortal_boundsHugeName() public {
        HugeNameERC20 t = new HugeNameERC20();
        uint256 gasBefore = gasleft();
        factory.createPortal(address(t));
        uint256 used = gasBefore - gasleft();
        assertLt(used, 600_000, "a 100 KB name must not be copied into memory");
        // Building a 100 KB return exhausts the metadata gas cap inside the token, so the read fails
        // closed: an empty name, a portal all the same.
        assertEq(factory.registrationOf(address(t)).nameWord, bytes32(0));
        assertEq(factory.registrationOf(address(t)).symbolWord, word("HUGE"));
        assertEq(factory.portalOf(address(t)), factory.predictPortal(address(t)));
    }

    /// A string head with no data word must not sanitize the empty buffer into 31 underscores.
    function test_createPortal_headlessStringFailsClosedToEmpty() public {
        HeadlessStringERC20 t = new HeadlessStringERC20();
        factory.createPortal(address(t));
        assertEq(factory.registrationOf(address(t)).nameWord, bytes32(0));
        assertEq(factory.registrationOf(address(t)).symbolWord, word("HEAD"));
    }

    function test_createPortal_reentrantNameFailsClosed() public {
        ReentrantNameERC20 t = new ReentrantNameERC20();
        t.setFactory(factory);
        factory.createPortal(address(t));
        // The reentrant STATICCALL reverts inside name(), which reports "blocked".
        assertEq(factory.registrationOf(address(t)).nameWord, word("blocked"));
        assertEq(factory.portalOf(address(t)), factory.predictPortal(address(t)));
    }

    // ── Guardian ──────────────────────────────────────────────────────────────────────

    function test_entries_startPaused_andOnlyTheGuardianFlipsThem() public {
        assertTrue(factory.entriesPaused(), "a new generation starts paused");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.setEntriesPaused(false);

        vm.prank(guardian);
        vm.expectEmit(true, true, true, true);
        emit IPortalFactory.EntriesPausedChanged(false);
        factory.setEntriesPaused(false);
        assertFalse(factory.entriesPaused());

        vm.prank(guardian);
        factory.setEntriesPaused(true);
        assertTrue(factory.entriesPaused());
    }

    function test_constructor_rejectsZeroPoolOrCap() public {
        vm.expectRevert(IPortalFactory.ZeroPool.selector);
        new PortalFactory(IRegistry(address(registry)), HUB, IPrivacyPoolVault(address(0)), CAP, guardian);
        vm.expectRevert(IPortalFactory.ZeroCap.selector);
        new PortalFactory(IRegistry(address(registry)), HUB, POOL, 0, guardian);
    }

    /// Every clone reads the vault, the cap and the Aztec pointers from the one implementation.
    function test_clone_readsTheGenerationsBindings() public {
        PortalFactory capped = new PortalFactory(IRegistry(address(registry)), HUB, POOL, 1e12, guardian);
        ProcessorPortalImpl portal = ProcessorPortalImpl(capped.createPortal(address(usdc)));
        assertEq(address(portal.POOL()), address(POOL));
        assertEq(portal.LIFETIME_CAP(), 1e12);
        assertEq(address(portal.INBOX()), address(inbox));
        assertEq(address(portal.OUTBOX()), address(outbox));
        assertEq(portal.ROLLUP_VERSION(), 4242);
        assertEq(portal.grossAccepted(), 0);
        assertEq(portal.totalPaid(), 0);
    }

    function test_renounceOwnership_isDisabled() public {
        vm.prank(guardian);
        vm.expectRevert(IPortalFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
    }

    function test_ownership_isTwoStep() public {
        vm.prank(guardian);
        factory.transferOwnership(alice);
        assertEq(factory.owner(), guardian, "pending until accepted");
        vm.prank(alice);
        factory.acceptOwnership();
        assertEq(factory.owner(), alice);
    }

    function test_implementation_refusesDirectUse() public {
        ProcessorPortalImpl impl = ProcessorPortalImpl(factory.IMPLEMENTATION());
        vm.expectRevert(ProcessorPortalImpl.ImplementationOnly.selector);
        impl.underlying();
    }
}
