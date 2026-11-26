// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

import {IPrivacyPoolVault} from "../src/interfaces/IPrivacyPoolVault.sol";
import {PortalFixture} from "./helpers/PortalFixture.sol";

/// The whole envelope a production clone puts on the wire, compared with the shared wire-format
/// vectors (`packages/bridge-spec/vectors/v1.json`): the vault-facing `data`, the Inbox content and
/// secret hash, and the Outbox content of both exits. Every expected value is read from the file,
/// never recomputed with the library under test. Section sizes are written here by hand, so a
/// generator that drops a vector with its count still fails.
contract PortalVectorsTest is PortalFixture {
    uint256 internal constant DATA = 66;
    uint256 internal constant IN = 73;
    uint256 internal constant OUT = 69;
    uint256 internal constant RAGEQUIT = 71;

    // Field order is alphabetical: `vm.parseJson` encodes an object's keys sorted.
    struct DataVector {
        bytes data;
        bytes32 secretHash;
    }

    struct InVector {
        bytes32 amount;
        bytes32 changeCommitment;
        bytes32 content;
        bytes32 nullifier;
        bytes preimage;
    }

    struct OutVector {
        bytes32 amount;
        bytes32 content;
        address payee;
        bytes preimage;
    }

    struct RagequitVector {
        bytes32 amount;
        bytes32 content;
        bytes32 label;
        address payee;
        bytes preimage;
    }

    function setUp() public {
        _deploy(type(uint256).max);
    }

    /// Read once per test into memory: a storage copy of the file costs more per lookup than a run allows.
    function _json() internal view returns (string memory) {
        return vm.readFile(vm.envOr("BRIDGE_SPEC_VECTORS", string("../../../packages/bridge-spec/vectors/v1.json")));
    }

    function test_counts() public view {
        string memory json = _json();
        string[4] memory sections = ["data", "in", "out", "ragequit"];
        uint256[4] memory sizes = [DATA, IN, OUT, RAGEQUIT];
        for (uint256 s; s < sections.length; ++s) {
            assertEq(vm.parseJsonUint(json, string.concat(".counts.", sections[s])), sizes[s], sections[s]);
        }
        assertEq(_data(json).length, DATA);
        assertEq(abi.decode(vm.parseJson(json, ".in"), (InVector[])).length, IN);
        assertEq(abi.decode(vm.parseJson(json, ".out"), (OutVector[])).length, OUT);
        assertEq(abi.decode(vm.parseJson(json, ".ragequit"), (RagequitVector[])).length, RAGEQUIT);
    }

    /// The vault binds `data` through the proof's context, which is computed here from the vector's
    /// bytes: a bridge succeeds only if the portal passed exactly those bytes.
    function test_data_isTheBytesTheVaultBinds() public {
        DataVector[] memory v = _data(_json());
        assertEq(v.length, DATA);
        for (uint256 i; i < v.length; ++i) {
            uint256 snap = vm.snapshotState();
            IPrivacyPoolVault.TransactProof memory proof;
            proof.pubSignals = _signals(1, 2, 1000, uint160(address(token)), _context(address(portal), v[i].data, _notes()));
            portal.bridgeFromPool(proof, _notes(), v[i].secretHash);
            assertEq(inbox.lastSecretHash(), v[i].secretHash, vm.toString(i));
            vm.revertToState(snap);
        }
    }

    function test_in_isTheInboxContent() public {
        string memory json = _json();
        // One `data` vector supplies the secret hash and the bytes its proofs bind.
        DataVector memory d = _data(json)[0];
        uint256 context = _context(address(portal), d.data, _notes());
        InVector[] memory v = abi.decode(vm.parseJson(json, ".in"), (InVector[]));
        assertEq(v.length, IN);
        for (uint256 i; i < v.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 amount = uint256(v[i].amount);
            IPrivacyPoolVault.TransactProof memory proof;
            proof.pubSignals = _signals(
                uint256(v[i].nullifier), uint256(v[i].changeCommitment), amount, uint160(address(token)), context
            );
            portal.bridgeFromPool(proof, _notes(), d.secretHash);
            assertEq(inbox.lastContentHash(), v[i].content, vm.toString(i));
            assertEq(inbox.lastSecretHash(), d.secretHash);
            assertEq(inbox.lastBridge(), HUB);
            assertEq(inbox.lastVersion(), VERSION);
            assertEq(portal.grossAccepted(), amount);
            vm.revertToState(snap);
        }
    }

    function test_out_isTheOutboxContentOfAPublicExit() public {
        OutVector[] memory v = abi.decode(vm.parseJson(_json(), ".out"), (OutVector[]));
        assertEq(v.length, OUT);
        for (uint256 i; i < v.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 amount = uint256(v[i].amount);
            _bridge(portal, amount);
            portal.settlePublicExit(v[i].payee, amount, Epoch.wrap(1), 1, 0, new bytes32[](0));
            _assertOutbox(v[i].content, i);
            vm.revertToState(snap);
        }
    }

    function test_ragequit_isTheOutboxContentOfARagequit() public {
        RagequitVector[] memory v = abi.decode(vm.parseJson(_json(), ".ragequit"), (RagequitVector[]));
        assertEq(v.length, RAGEQUIT);
        for (uint256 i; i < v.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 amount = uint256(v[i].amount);
            _bridge(portal, amount);
            portal.settleRagequit(v[i].payee, amount, uint256(v[i].label), Epoch.wrap(1), 1, 0, new bytes32[](0));
            _assertOutbox(v[i].content, i);
            vm.revertToState(snap);
        }
    }

    function _data(string memory json) internal pure returns (DataVector[] memory) {
        return abi.decode(vm.parseJson(json, ".data"), (DataVector[]));
    }

    function _assertOutbox(bytes32 content, uint256 i) internal view {
        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        assertEq(m.content, content, vm.toString(i));
        assertEq(m.sender.actor, HUB);
        assertEq(m.sender.version, VERSION);
        assertEq(m.recipient.actor, address(portal));
        assertEq(m.recipient.chainId, block.chainid);
    }
}
