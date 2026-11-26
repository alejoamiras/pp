// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {ProcessorPortalImpl} from "../../src/ProcessorPortalImpl.sol";
import {IPrivacyPoolVault} from "../../src/interfaces/IPrivacyPoolVault.sol";

/// The portal with its content hash swapped for keccak, which halmos can run and sha256 it cannot.
/// The low 248 bits keep the result a field element like `sha256ToField`, and keep the 160 bits on
/// which halmos 0.3.3 treats keccak as injective. Nothing else may differ from production:
/// `check-halmos.sh` compares this contract's compiled interface and storage with the portal's.
contract ProcessorPortalHarness is ProcessorPortalImpl {
    constructor(IRegistry registry, bytes32 l2Hub, IPrivacyPoolVault pool, uint256 lifetimeCap)
        ProcessorPortalImpl(registry, l2Hub, pool, lifetimeCap)
    {}

    function _contentHash(bytes memory preimage) internal pure override returns (bytes32) {
        return bytes32(uint256(keccak256(preimage)) & type(uint248).max);
    }
}
