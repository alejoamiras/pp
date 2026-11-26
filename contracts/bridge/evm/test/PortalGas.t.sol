// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The metered portal calls `.gas-snapshot` pins. The fakes stand in for the Inbox and Outbox, so
/// the numbers track the factory and clone code, not Aztec's L1 contracts.
contract PortalGasTest is Test {
    PortalFactory internal factory;
    PlainERC20 internal fresh;

    function setUp() public {
        FakeRegistry registry =
            new FakeRegistry(address(new FakeRollup(address(new CapturingInbox()), address(new CapturingOutbox()))));
        factory = new PortalFactory(
            IRegistry(address(registry)),
            bytes32(uint256(0x4B)),
            IPrivacyPoolVault(address(0x9001)),
            type(uint256).max,
            makeAddr("guardian")
        );
        // A first portal warms the fake Inbox's slots, so the metered call pays only for factory code.
        factory.createPortal(address(new PlainERC20("Tok", "TOK")));
        fresh = new PlainERC20("Fresh", "FRSH");
    }

    function test_gas_createPortal_freshToken() public {
        factory.createPortal(address(fresh));
    }
}
