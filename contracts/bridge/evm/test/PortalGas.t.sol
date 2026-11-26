// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";
import {PlainERC20} from "./mocks/MetadataERC20s.sol";

/// The metered portal calls `.gas-snapshot` pins. The fakes stand in for the Inbox, the Outbox and
/// the vault, so the numbers track the factory and clone code, not Aztec's or the pool's contracts.
/// Each case runs on warm state: one bridge and one settle already landed, as on a live clone.
contract PortalGasTest is PortalFixture {
    address internal constant PAYEE = address(0xBEEF);

    PlainERC20 internal fresh;
    IPrivacyPoolVault.TransactProof internal proof;

    function setUp() public {
        _deploy(type(uint256).max);
        fresh = new PlainERC20("Fresh", "FRSH");
        _bridge(portal, 10_000);
        _settlePublicExit(portal, PAYEE, 1);
        // The fake Inbox's slot writes are cheaper when a message repeats the last one's sender and
        // secret hash, so the metered creation follows a creation.
        factory.createPortal(address(new PlainERC20("Warm", "WRM")));
        (proof,) = _proof(portal, 1000, SECRET_HASH);
    }

    function test_gas_createPortal_freshToken() public {
        factory.createPortal(address(fresh));
    }

    function test_gas_bridgeFromPool() public {
        portal.bridgeFromPool(proof, _notes(), SECRET_HASH);
    }

    function test_gas_settleRagequit() public {
        portal.settleRagequit(PAYEE, 1000, 0x1abe1, Epoch.wrap(1), 1, 0, new bytes32[](0));
    }

    function test_gas_settlePublicExit() public {
        portal.settlePublicExit(PAYEE, 1000, Epoch.wrap(1), 1, 0, new bytes32[](0));
    }
}
