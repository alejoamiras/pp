// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";

import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPrivacyPoolVault} from "./interfaces/IPrivacyPoolVault.sol";

/// @notice The implementation every token's clone delegates to: the Privacy Pools processor that
/// holds the bridged units of one token. A clone has no initializer: its token is an immutable arg in
/// its own bytecode, the Aztec pointers, vault and cap are immutables of this implementation, and the
/// guardian's entry pause lives on the factory. Its only storage is the two counters that bound what
/// it may ever pay.
contract ProcessorPortalImpl is ReentrancyGuardTransient {
    error ImplementationOnly();

    IPortalFactory public immutable FACTORY;
    IInbox public immutable INBOX;
    IOutbox public immutable OUTBOX;
    uint256 public immutable ROLLUP_VERSION;
    bytes32 public immutable L2_HUB;
    IPrivacyPoolVault public immutable POOL;
    uint256 public immutable LIFETIME_CAP;
    /// @dev Entries and exits must run in a clone, never in this contract itself.
    address private immutable SELF;

    /// @notice Every unit the vault has paid this clone through a bridge; never decreases, capped by LIFETIME_CAP.
    uint256 public grossAccepted;
    /// @notice Every unit this clone has paid against a proven exit; never exceeds grossAccepted.
    uint256 public totalPaid;

    constructor(IRegistry registry, bytes32 l2Hub, IPrivacyPoolVault pool, uint256 lifetimeCap) {
        FACTORY = IPortalFactory(msg.sender);
        IRollup rollup = IRollup(address(registry.getCanonicalRollup()));
        INBOX = rollup.getInbox();
        OUTBOX = rollup.getOutbox();
        ROLLUP_VERSION = rollup.getVersion();
        L2_HUB = l2Hub;
        POOL = pool;
        LIFETIME_CAP = lifetimeCap;
        SELF = address(this);
    }

    function underlying() public view returns (IERC20) {
        if (address(this) == SELF) revert ImplementationOnly();
        return IERC20(address(bytes20(Clones.fetchCloneArgs(address(this)))));
    }
}
