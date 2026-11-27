// The Sepolia states the suite proves compatibility with, one block per target. A pass means "compatible at
// this block", not "compatible with today's chain": the live check reports when the deployment moves.
//
// Refresh, when the live check names a binding that moved: pick a finalized block, run
// `SEPOLIA_RPC_URL=<endpoint> bun run --cwd packages/sepolia-fork pins <block> --target <name>`, check the
// block's hash on a second endpoint, and replace that target's `block` and `bindings` with what it prints.
// The fixed addresses change only with a new deployment. Loads nothing but viem (`@pp/sepolia-fork/pins`).
import type { Address, Hex } from "viem"
import type { PoolCode } from "./code.ts"

export {
	type CodeReader,
	type ContractCode,
	codeMismatches,
	EIP1967_IMPLEMENTATION_SLOT,
	EMPTY_CODE_HASH,
	POOL_CONTRACTS,
	type PoolCode,
	type PoolContract,
	readPoolCode,
} from "./code.ts"

export const SEPOLIA_CHAIN_ID = 11_155_111

/** What the preflight reads and compares, on the fork at the pinned block and live at `finalized`. */
export type Bindings = {
	/** The four pool contracts' proxy and implementation code. */
	code: PoolCode
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

/** A pool-client circuit bundle; the target's verifiers must embed its keys. */
export type BundleName = "ceremony" | "pre-ceremony"

export type Pins = {
	block: { number: bigint; hash: Hex }
	pool: {
		vault: Address
		entrypoint: Address
		keystore: Address
		aspRegistry: Address
		/** A sender whose root posts the registry accepts; the fork's mock ASP posts as it. */
		postman: Address
		deployBlock: bigint
		usdc: Address
	}
	aztec: { registry: Address }
	bindings: Bindings
	bundle: BundleName
}

export type TargetName = "pool1" | "vault-323c"

const AZTEC_TESTNET = {
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
	rollup: "0x1f435a7F2dA358caF887A470FAeEE7d5D5f4eFBA",
	rollupVersion: 679_261_766n,
	inbox: "0x7cdC32Dd7d008870A95f1837Ffd7229ef676EF8A",
	inboxCodeHash: "0x73282f62d0d7eeeb38cd916b779e9b9eb3843b670182360106533d93b3c86be9",
	outbox: "0xA5A0f7a7BDAf280964a1922A68C83462E5F6E15b",
} as const
const { registry, ...aztecBindings } = AZTEC_TESTNET
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"

/** Every proxy of both targets runs this one minimal ERC-1967 proxy: it delegates to its implementation slot alone. */
const ERC1967_PROXY_CODE_HASH = "0x734d250afdad5c1a4a510abb21380a2ec435c89ffc73e805a8a8d74c5cee7568"

/** Read at the target's pinned block. pool1's vault (upgraded at block 11095581) and keystore (11085847) run unpublished builds. */
const CODE_POOL1: PoolCode = {
	vault: {
		proxy: "0x4DECEef285a24CA05999870887C895042731D7cB",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x1B36d629066635AF8d87B03844f19414fda02b5e",
		implementationCodeHash: "0xfc2dc22bb4f07879395ed2a955a07df68109a905e54c8a0081de27268d5762b1",
	},
	entrypoint: {
		proxy: "0x3191ED61Bc961667f368600caf147F08CffA2559",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x06332DD1411624c2909A8A30F0fa5612e70F71c7",
		implementationCodeHash: "0x4a7ac1ae8f7bb64a26e6ea0b8c11cb3de3a691ae3a170bc71b4b75dab9aa3b9f",
	},
	keystore: {
		proxy: "0x5b8883a2F8339560d8ebFeaabf93Ce4e7056c4cA",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x8d09ec4b814Fd6ce41062D0ae5a68E5B9F11Ad82",
		implementationCodeHash: "0x1895cafe8e1e9a28be4a159da4edfac294a65d1762e2595220c56f0071e84a8d",
	},
	aspRegistry: {
		proxy: "0x836aCbf56832FD11492E4a4ba1BA40F6e361df66",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0xE00B278036beA76f1948E9B28834b5cA2F9CE5ED",
		implementationCodeHash: "0xf4069ac59f82c91598773ef96dcc457e35533e0173475fdceb17c1974ad147ec",
	},
}

const CODE_VAULT_323C: PoolCode = {
	vault: {
		proxy: "0x323C28ce5f21192Df8009215D3aBdf6011158347",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0xfd4276B55c2975335Baa148e1b290708e3f2178b",
		implementationCodeHash: "0x81fea8e3f85c5f31aef9eaa2d520271dcb2086eee47264774a25c4c34706e002",
	},
	entrypoint: {
		proxy: "0x49Eac830F663578BDF2344C7371DC669DEaCf176",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x9A0eA2E509a41599A9779FF440859a64cF80F37d",
		implementationCodeHash: "0x605e452cda7dd94b0f5d92786685a93c6decca34a6aca4561b2908fd74063cac",
	},
	keystore: {
		proxy: "0x59c4BfBC334Ba0CC717C2dC80a2D6e83C0CEBda9",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x5f79F6f44E420ce31CC9A4dC0BE0836652b3B606",
		implementationCodeHash: "0x301ef2aacb5671ae7e8c12be3ac7f448b3c3bf1aa38495209f409802d5a6b9f0",
	},
	aspRegistry: {
		proxy: "0x264D76933F80009dE335f5f86A894FE4e71495c9",
		proxyCodeHash: ERC1967_PROXY_CODE_HASH,
		implementation: "0x27BBc4f30213768eeDB5393dDa39926Be3dd7754",
		implementationCodeHash: "0xc9042f426a4c1568921e9bef6f0fa2c4024edc882ba5b3d3d1d2decfc9ca33cb",
	},
}

export const TARGETS: Readonly<Record<TargetName, Pins>> = {
	/** The operator's live pool (its API's poolId 1): ceremony keys, upgraded once to an unpublished build. */
	pool1: {
		block: { number: 12_224_362n, hash: "0x6da3a11a0f9ec4bd6d9b22c4a5ea708e4d23ec3a85dc7fa871d69bde7bf87bd9" },
		pool: {
			vault: "0x4deceef285a24ca05999870887c895042731d7cb",
			entrypoint: "0x3191ED61Bc961667f368600caf147F08CffA2559",
			keystore: "0x5b8883a2f8339560d8ebfeaabf93ce4e7056c4ca",
			aspRegistry: "0x836acbf56832fd11492e4a4ba1ba40f6e361df66",
			postman: "0x696fe46495688fc9e99bad2daf2133b33de364ea",
			deployBlock: 10_956_341n,
			usdc: USDC,
		},
		aztec: { registry },
		bindings: {
			code: CODE_POOL1,
			depositVerifier: "0x2b2Dc2d979410DA2D1a2fc08982b60EBd05Fc452",
			transact1x1Verifier: "0xDE01899950397B9d5401A505b194b1B21Bf4E0e4",
			transact1x1Selector: "0xc9219a7a",
			transact1x1VerifierCodeHash: "0x2440fb60a451ef891e6ef079441ad855c61b2888a12d77e448315fe747147c49",
			...aztecBindings,
		},
		bundle: "ceremony",
	},
	/** An older deployment of the same operator, on single-party pre-ceremony keys; no ASP root was ever posted to it. */
	"vault-323c": {
		block: { number: 12_220_000n, hash: "0x01b784173c30503fef5ba5ac2d23367ac8014ba75e8161e3bfd05520e00e416d" },
		pool: {
			vault: "0x323C28ce5f21192Df8009215D3aBdf6011158347",
			entrypoint: "0x49Eac830F663578BDF2344C7371DC669DEaCf176",
			keystore: "0x59c4BfBC334Ba0CC717C2dC80a2D6e83C0CEBda9",
			aspRegistry: "0x264D76933F80009dE335f5f86A894FE4e71495c9",
			postman: "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b",
			deployBlock: 10_875_479n,
			usdc: USDC,
		},
		aztec: { registry },
		bindings: {
			code: CODE_VAULT_323C,
			depositVerifier: "0xF83937b8039C8d7400b876680CEE9C9444b47CEF",
			transact1x1Verifier: "0xDd908137f7A7AEEb72c398f29F9D2e441fA2560E",
			transact1x1Selector: "0xc9219a7a",
			transact1x1VerifierCodeHash: "0xbdbe6c6b6a7067f2bd881593ab8e497c37a4bf0be5995b82993e7812d1068c87",
			...aztecBindings,
		},
		bundle: "pre-ceremony",
	},
}

export const DEFAULT_TARGET: TargetName = "pool1"

export const isTargetName = (name: string): name is TargetName => Object.hasOwn(TARGETS, name)
