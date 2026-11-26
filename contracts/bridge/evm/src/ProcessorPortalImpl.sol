// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {IPrivacyPoolVault} from "./interfaces/IPrivacyPoolVault.sol";
import {BridgeMessageV1} from "./libraries/BridgeMessageV1.sol";

/// @notice The implementation every token's clone delegates to: the Privacy Pools processor that
/// holds the bridged units of one token. A clone has no initializer: its token is an immutable arg in
/// its own bytecode, the Aztec pointers, vault and cap are immutables of this implementation, and the
/// guardian's entry pause lives on the factory. Its only storage is the two counters that bound what
/// it may ever pay.
/// @dev Every check and every encoding runs before the first external call that moves value. An
/// exit pays at most `grossAccepted - totalPaid`, so a forged Outbox message can take no more than
/// what this clone holds for the bridge, and a donation is never payable.
contract ProcessorPortalImpl is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error ImplementationOnly();
    error EntriesPaused();
    error BadSignalShape();
    error WrongToken(uint256 tokenIdOut);
    error CapExceeded(uint256 grossAccepted, uint256 amount);
    error InexactPayment(uint256 expected, uint256 received);
    error PayeeIsPortal();
    error ExceedsReserve(uint256 outstanding, uint256 amount);
    error InexactTransfer();

    event BridgedFromPool(
        bytes32 indexed messageKey, uint256 leafIndex, uint256 indexed nullifier, uint256 changeCommitment, uint256 amount
    );
    /// @dev `label` 0 marks a screened public exit; a ragequit's label is never 0. `(epoch, leafId)` is
    /// the pair the Outbox nullifies, so it names exactly one exit and is emitted at most once.
    event ExitSettled(address indexed payee, uint256 amount, uint256 indexed label, Epoch indexed epoch, uint256 leafId);

    /// @dev Rows of the vault's public signals. Only a one-input, one-output spend may reach the vault,
    /// and every scalar row must hold exactly one word.
    uint256 private constant SIGNAL_ROWS = 8;
    uint256 private constant NULLIFIERS = 0;
    uint256 private constant COMMITMENTS = 1;
    uint256 private constant AMOUNT_OUT = 5;
    uint256 private constant TOKEN_ID_OUT = 6;

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

    /// @notice Spends one pool note into this clone and sends its value to Aztec. The proof's public
    /// signals carry the nullifier, change commitment, amount and token; `secretHash` gates the claim.
    /// @dev The vault checks the proof and that `processor == msg.sender` and binds `data` and
    /// `noteData` through the proof's context, so this clone must pass exactly the params a client proved.
    function bridgeFromPool(
        IPrivacyPoolVault.TransactProof calldata proof,
        IPrivacyPoolVault.NoteData[] calldata noteData,
        bytes32 secretHash
    ) external nonReentrant returns (bytes32 messageKey, uint256 leafIndex) {
        if (FACTORY.entriesPaused()) revert EntriesPaused();
        uint256[][] calldata signals = proof.pubSignals;
        _requireShape(signals);
        IERC20 token = underlying();
        // The raw word, so a token id with bits above 160 or the vault's native-asset id never matches.
        uint256 tokenIdOut = signals[TOKEN_ID_OUT][0];
        if (tokenIdOut != uint160(address(token))) revert WrongToken(tokenIdOut);

        uint256 nullifier = signals[NULLIFIERS][0];
        uint256 changeCommitment = signals[COMMITMENTS][0];
        uint256 amount = signals[AMOUNT_OUT][0];
        bytes memory data = BridgeMessageV1.bridgeData(secretHash);
        bytes32 content = _contentHash(BridgeMessageV1.bridgeContentPreimage(nullifier, changeCommitment, amount));
        uint256 accepted = grossAccepted;
        if (amount > LIFETIME_CAP - accepted) revert CapExceeded(accepted, amount);

        uint256 before = token.balanceOf(address(this));
        POOL.transact(proof, IPrivacyPoolVault.TransactParams(address(this), data), noteData);
        uint256 balance = token.balanceOf(address(this));
        if (balance < before) revert InexactPayment(amount, 0);
        if (balance - before != amount) revert InexactPayment(amount, balance - before);

        grossAccepted = accepted + amount;
        (messageKey, leafIndex) =
            INBOX.sendL2Message(DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION), content, secretHash);
        emit BridgedFromPool(messageKey, leafIndex, nullifier, changeCommitment, amount);
    }

    /// @notice Pays a proven ragequit: `amount` to `payee`, who keeps the note's `label`. Anyone may
    /// call; the message fixes the payee. Never paused.
    function settleRagequit(
        address payee,
        uint256 amount,
        uint256 label,
        Epoch epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external nonReentrant {
        bytes memory preimage = BridgeMessageV1.ragequitContentPreimage(payee, amount, label);
        _settle(payee, amount, label, preimage, epoch, numCheckpointsInEpoch, leafIndex, path);
    }

    /// @notice Pays a proven, screened public exit: `amount` to `payee`. Anyone may call; the message
    /// fixes the payee. Never paused.
    function settlePublicExit(
        address payee,
        uint256 amount,
        Epoch epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external nonReentrant {
        bytes memory preimage = BridgeMessageV1.exitContentPreimage(payee, amount);
        _settle(payee, amount, 0, preimage, epoch, numCheckpointsInEpoch, leafIndex, path);
    }

    /// @dev Production is exactly Aztec's `sha256ToField`. It is the only hash on a message path, so a
    /// test harness can replace it where halmos cannot run sha256.
    function _contentHash(bytes memory preimage) internal pure virtual returns (bytes32) {
        return Hash.sha256ToField(preimage);
    }

    /// @dev A failed payout reverts the whole call, which restores `totalPaid` and the Outbox leaf, so
    /// the exit stays retryable. The Outbox nullifies by (epoch, leaf), so identical exits at distinct
    /// leaves each pay once.
    function _settle(
        address payee,
        uint256 amount,
        uint256 label,
        bytes memory preimage,
        Epoch epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) private {
        if (payee == address(this)) revert PayeeIsPortal();
        uint256 paid = totalPaid;
        uint256 outstanding = grossAccepted - paid;
        if (amount > outstanding) revert ExceedsReserve(outstanding, amount);

        totalPaid = paid + amount;
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(L2_HUB, ROLLUP_VERSION),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: _contentHash(preimage)
        });
        OUTBOX.consume(message, epoch, numCheckpointsInEpoch, leafIndex, path);
        // The Outbox's own leaf id; leafIndex alone repeats across epochs and tree heights.
        // forge-lint: disable-next-line(incorrect-shift)
        uint256 leafId = (1 << path.length) + leafIndex;

        // Exact debit protects the reserve; what the payee nets is the token's business.
        IERC20 token = underlying();
        uint256 before = token.balanceOf(address(this));
        token.safeTransfer(payee, amount);
        uint256 balance = token.balanceOf(address(this));
        if (balance > before || before - balance != amount) revert InexactTransfer();
        emit ExitSettled(payee, amount, label, epoch, leafId);
    }

    function _requireShape(uint256[][] calldata signals) private pure {
        if (signals.length != SIGNAL_ROWS) revert BadSignalShape();
        for (uint256 row = 0; row < SIGNAL_ROWS; row++) {
            if (signals[row].length != 1) revert BadSignalShape();
        }
    }
}
