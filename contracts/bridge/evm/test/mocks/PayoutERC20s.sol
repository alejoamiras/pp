// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ERC20} from "@oz/token/ERC20/ERC20.sol";

/// Takes one extra unit from the sender of every transfer: an issuer that turned on a fee charged to
/// the payer, which a portal paying exits must refuse rather than drain its reserve.
contract SurchargeERC20 is ERC20 {
    constructor() ERC20("Surcharge", "SUR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to != address(0)) super._update(from, address(0xFEE), 1);
    }
}
