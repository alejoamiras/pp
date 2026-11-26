// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The metered portal calls `.gas-snapshot` pins. The fakes stand in for the Inbox and Outbox, so
/// the numbers track the factory and clone code, not Aztec's L1 contracts.
contract PortalGasTest is Test {
    PortalFactory internal factory;
    TokenPortalImpl internal portal;
    PlainERC20 internal token;
    PlainERC20 internal fresh;

    function setUp() public {
        FakeRegistry registry =
            new FakeRegistry(address(new FakeRollup(address(new CapturingInbox()), address(new CapturingOutbox()))));
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), makeAddr("guardian"));
        token = new PlainERC20("Tok", "TOK");
        portal = TokenPortalImpl(factory.createPortal(address(token)));
        token.mint(address(this), 1e30);
        token.approve(address(portal), type(uint256).max);
        token.mint(address(portal), 1e30);
        fresh = new PlainERC20("Fresh", "FRSH");
    }

    function test_gas_createPortal_freshToken() public {
        factory.createPortal(address(fresh));
    }

    function test_gas_depositToAztecPublic() public {
        portal.depositToAztecPublic(bytes32(uint256(1)), 1e18, bytes32(uint256(2)));
    }

    function test_gas_depositToAztecPrivate() public {
        portal.depositToAztecPrivate(1e18, bytes32(uint256(2)));
    }

    function test_gas_withdraw() public {
        portal.withdraw(address(0xB0B), 1e18, false, Epoch.wrap(0), 0, 0, new bytes32[](0));
    }
}
