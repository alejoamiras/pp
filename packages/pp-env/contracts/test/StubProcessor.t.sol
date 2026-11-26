// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVaultMinimal} from "../src/IPoolVaultMinimal.sol";
import {StubProcessor} from "../src/StubProcessor.sol";
import {TestToken} from "../src/TestToken.sol";

/// @dev Enforces the real vault's processor rule and pays `shortfall` less than amountOut.
contract MockPoolVault is IPoolVaultMinimal {
    IERC20 public immutable TOKEN;
    uint256 public shortfall;
    uint256 public calls;

    constructor(IERC20 token) {
        TOKEN = token;
    }

    function setShortfall(uint256 s) external {
        shortfall = s;
    }

    function transact(TransactProof calldata proof, TransactParams calldata params, NoteData[] calldata) external {
        require(params.processor == msg.sender, "processor");
        ++calls;
        TOKEN.transfer(msg.sender, proof.pubSignals[5][0] - shortfall);
    }
}

contract StubProcessorTest is Test {
    TestToken token;
    MockPoolVault vault;
    StubProcessor stub;

    uint256 constant NULLIFIER = 0xaa;
    uint256 constant CHANGE = 0xbb;
    uint256 constant AMOUNT = 70e6;

    function setUp() public {
        token = new TestToken();
        vault = new MockPoolVault(token);
        stub = new StubProcessor(vault, token);
        token.mint(address(vault), 1_000e6);
    }

    function _proof(uint256 nNullifiers, uint256 nCommitments, uint256 tokenIdOut)
        internal
        pure
        returns (IPoolVaultMinimal.TransactProof memory p)
    {
        p.pubSignals = new uint256[][](8);
        p.pubSignals[0] = new uint256[](nNullifiers);
        p.pubSignals[1] = new uint256[](nCommitments);
        if (nNullifiers > 0) p.pubSignals[0][0] = NULLIFIER;
        if (nCommitments > 0) p.pubSignals[1][0] = CHANGE;
        for (uint256 i = 2; i < 8; ++i) {
            p.pubSignals[i] = new uint256[](1);
        }
        p.pubSignals[5][0] = AMOUNT;
        p.pubSignals[6][0] = tokenIdOut;
    }

    function _params() internal view returns (IPoolVaultMinimal.TransactParams memory) {
        return IPoolVaultMinimal.TransactParams({processor: address(stub), data: hex"c0ffee"});
    }

    function _tokenId() internal view returns (uint256) {
        return uint256(uint160(address(token)));
    }

    function test_RecordsSpendAndEmits() public {
        vm.expectEmit(address(stub));
        emit StubProcessor.Processed(NULLIFIER, CHANGE, address(token), AMOUNT, hex"c0ffee");
        stub.spend(_proof(1, 1, _tokenId()), _params(), new IPoolVaultMinimal.NoteData[](1));

        (address asset, uint256 amount, uint256 nullifier, uint256 change) = stub.lastSpend();
        assertEq(asset, address(token));
        assertEq(amount, AMOUNT);
        assertEq(nullifier, NULLIFIER);
        assertEq(change, CHANGE);
        assertEq(stub.spendCount(), 1);
        assertEq(token.balanceOf(address(stub)), AMOUNT);
    }

    function testFuzz_RevertsUnlessOneInOneOut(uint8 n, uint8 m) public {
        n = uint8(bound(n, 0, 5));
        m = uint8(bound(m, 0, 5));
        vm.assume(n != 1 || m != 1);
        IPoolVaultMinimal.TransactProof memory p = _proof(n, m, _tokenId());
        vm.expectRevert(abi.encodeWithSelector(StubProcessor.NotOneInOneOut.selector, uint256(n), uint256(m)));
        stub.spend(p, _params(), new IPoolVaultMinimal.NoteData[](0));
    }

    function test_RevertsOnOtherTokenBeforeCallingVault() public {
        uint256 other = uint256(uint160(makeAddr("other")));
        vm.expectRevert(abi.encodeWithSelector(StubProcessor.UnexpectedToken.selector, other));
        stub.spend(_proof(1, 1, other), _params(), new IPoolVaultMinimal.NoteData[](1));
        assertEq(vault.calls(), 0);
    }

    function test_RevertsOnShortPayment() public {
        vault.setShortfall(1);
        vm.expectRevert(abi.encodeWithSelector(StubProcessor.PaymentMismatch.selector, AMOUNT, AMOUNT - 1));
        stub.spend(_proof(1, 1, _tokenId()), _params(), new IPoolVaultMinimal.NoteData[](1));
        assertEq(stub.spendCount(), 0);
    }
}
