// The Sepolia state the suite proves compatibility with, at one block. A pass means "compatible at
// this block", not "compatible with today's chain": the live check reports when the deployment moves.
//
// Refresh, when the live check names a binding that moved: pick a finalized block, run
// `SEPOLIA_RPC_URL=<endpoint> bun run --cwd packages/sepolia-fork pins <block>`, and replace `block` and
// `bindings` with what it prints. The fixed addresses below change only with a new deployment.
import type { Address, Hex } from "viem"

export const SEPOLIA_CHAIN_ID = 11_155_111

/** What the preflight reads and compares, on the fork at the pinned block and live at `finalized`. */
export type Bindings = {
	/** The pool vault proxy's EIP-1967 implementation, and its runtime code's keccak256. */
	vaultImplementation: Address
	vaultImplementationCodeHash: Hex
	depositVerifier: Address
	/** The vault's verifier route for one input and one output, from its ERC-7201 router storage. */
	transact1x1Verifier: Address
	transact1x1Selector: Hex
	transact1x1VerifierCodeHash: Hex
	/** Aztec testnet: the registry's canonical rollup and what it names. */
	rollup: Address
	rollupVersion: bigint
	inbox: Address
	inboxCodeHash: Hex
	outbox: Address
}

export type Pins = {
	block: { number: bigint; hash: Hex }
	/** The pool's V8 deployment. */
	pool: {
		vault: Address
		entrypoint: Address
		keystore: Address
		aspRegistry: Address
		postman: Address
		deployBlock: bigint
		usdc: Address
	}
	aztec: { registry: Address }
	bindings: Bindings
}

export const PINS: Pins = {
	block: { number: 12_220_000n, hash: "0x01b784173c30503fef5ba5ac2d23367ac8014ba75e8161e3bfd05520e00e416d" },
	pool: {
		vault: "0x323C28ce5f21192Df8009215D3aBdf6011158347",
		entrypoint: "0x49Eac830F663578BDF2344C7371DC669DEaCf176",
		keystore: "0x59c4BfBC334Ba0CC717C2dC80a2D6e83C0CEBda9",
		aspRegistry: "0x264D76933F80009dE335f5f86A894FE4e71495c9",
		postman: "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b",
		deployBlock: 10_875_479n,
		usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	},
	aztec: { registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba" },
	bindings: {
		vaultImplementation: "0xfd4276b55c2975335baa148e1b290708e3f2178b",
		vaultImplementationCodeHash: "0x81fea8e3f85c5f31aef9eaa2d520271dcb2086eee47264774a25c4c34706e002",
		depositVerifier: "0xF83937b8039C8d7400b876680CEE9C9444b47CEF",
		transact1x1Verifier: "0xDd908137f7A7AEEb72c398f29F9D2e441fA2560E",
		transact1x1Selector: "0xc9219a7a",
		transact1x1VerifierCodeHash: "0xbdbe6c6b6a7067f2bd881593ab8e497c37a4bf0be5995b82993e7812d1068c87",
		rollup: "0x1f435a7F2dA358caF887A470FAeEE7d5D5f4eFBA",
		rollupVersion: 679_261_766n,
		inbox: "0x7cdC32Dd7d008870A95f1837Ffd7229ef676EF8A",
		inboxCodeHash: "0x73282f62d0d7eeeb38cd916b779e9b9eb3843b670182360106533d93b3c86be9",
		outbox: "0xA5A0f7a7BDAf280964a1922A68C83462E5F6E15b",
	},
}
