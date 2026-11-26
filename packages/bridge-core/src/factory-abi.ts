/**
 * Minimal PortalFactory + processor-portal ABIs for browser callers, which cannot read forge
 * artifacts at runtime. Hand-written and PINNED against the forge artifacts by
 * factory-abi.test.ts — any drift between these consts and the compiled contracts fails the suite.
 */

const REGISTRATION_COMPONENTS = [
	{ name: "portal", type: "address" },
	{ name: "decimals", type: "uint8" },
	{ name: "registerIndex", type: "uint64" },
	{ name: "nameWord", type: "bytes32" },
	{ name: "symbolWord", type: "bytes32" },
	{ name: "registerKey", type: "bytes32" },
] as const

export const PORTAL_FACTORY_ABI = [
	{
		type: "function",
		name: "createPortal",
		stateMutability: "nonpayable",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "portal", type: "address" }],
	},
	{
		type: "function",
		name: "predictPortal",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "portalOf",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "tokenOf",
		stateMutability: "view",
		inputs: [{ name: "portal", type: "address" }],
		outputs: [{ name: "token", type: "address" }],
	},
	{
		type: "function",
		name: "registrationOf",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "tuple", components: REGISTRATION_COMPONENTS }],
	},
	{ type: "function", name: "entriesPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
	{
		type: "function",
		name: "setEntriesPaused",
		stateMutability: "nonpayable",
		inputs: [{ name: "paused", type: "bool" }],
		outputs: [],
	},
	{ type: "function", name: "IMPLEMENTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "L2_HUB", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
	{
		type: "event",
		name: "PortalCreated",
		inputs: [
			{ name: "token", type: "address", indexed: true },
			{ name: "portal", type: "address", indexed: true },
			{ name: "nameWord", type: "bytes32", indexed: false },
			{ name: "symbolWord", type: "bytes32", indexed: false },
			{ name: "decimals", type: "uint8", indexed: false },
			{ name: "registerKey", type: "bytes32", indexed: false },
			{ name: "registerIndex", type: "uint256", indexed: false },
		],
	},
	{ type: "event", name: "EntriesPausedChanged", inputs: [{ name: "paused", type: "bool", indexed: false }] },
	{ type: "error", name: "NotAContract", inputs: [] },
	{ type: "error", name: "NoDecimals", inputs: [] },
] as const

const view = <const N extends string, const T extends string>(name: N, type: T) =>
	({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type }] }) as const

export const PROCESSOR_PORTAL_ABI = [
	view("underlying", "address"),
	view("FACTORY", "address"),
	view("L2_HUB", "bytes32"),
	view("POOL", "address"),
	view("LIFETIME_CAP", "uint256"),
	view("grossAccepted", "uint256"),
	view("totalPaid", "uint256"),
	{
		type: "function",
		name: "bridgeFromPool",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "proof",
				type: "tuple",
				components: [
					{ name: "pA", type: "uint256[2]" },
					{ name: "pB", type: "uint256[2][2]" },
					{ name: "pC", type: "uint256[2]" },
					{ name: "pubSignals", type: "uint256[][]" },
				],
			},
			{
				name: "noteData",
				type: "tuple[]",
				components: [
					{ name: "hint", type: "bytes32" },
					{ name: "data", type: "bytes" },
				],
			},
			{ name: "secretHash", type: "bytes32" },
		],
		outputs: [
			{ name: "messageKey", type: "bytes32" },
			{ name: "leafIndex", type: "uint256" },
		],
	},
	{
		type: "function",
		name: "settlePublicExit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "payee", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "epoch", type: "uint256" },
			{ name: "numCheckpointsInEpoch", type: "uint256" },
			{ name: "leafIndex", type: "uint256" },
			{ name: "path", type: "bytes32[]" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "settleRagequit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "payee", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "label", type: "uint256" },
			{ name: "epoch", type: "uint256" },
			{ name: "numCheckpointsInEpoch", type: "uint256" },
			{ name: "leafIndex", type: "uint256" },
			{ name: "path", type: "bytes32[]" },
		],
		outputs: [],
	},
	{
		type: "event",
		name: "BridgedFromPool",
		inputs: [
			{ name: "messageKey", type: "bytes32", indexed: true },
			{ name: "leafIndex", type: "uint256", indexed: false },
			{ name: "nullifier", type: "uint256", indexed: true },
			{ name: "changeCommitment", type: "uint256", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "ExitSettled",
		inputs: [
			{ name: "payee", type: "address", indexed: true },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "label", type: "uint256", indexed: true },
			{ name: "epoch", type: "uint256", indexed: true },
			{ name: "leafId", type: "uint256", indexed: false },
		],
	},
	{ type: "error", name: "BadSignalShape", inputs: [] },
	{
		type: "error",
		name: "CapExceeded",
		inputs: [
			{ name: "grossAccepted", type: "uint256" },
			{ name: "amount", type: "uint256" },
		],
	},
	{ type: "error", name: "EntriesPaused", inputs: [] },
	{
		type: "error",
		name: "ExceedsReserve",
		inputs: [
			{ name: "outstanding", type: "uint256" },
			{ name: "amount", type: "uint256" },
		],
	},
	{
		type: "error",
		name: "InexactPayment",
		inputs: [
			{ name: "expected", type: "uint256" },
			{ name: "received", type: "uint256" },
		],
	},
	{ type: "error", name: "InexactTransfer", inputs: [] },
	{ type: "error", name: "PayeeIsPortal", inputs: [] },
	{ type: "error", name: "WrongToken", inputs: [{ name: "tokenIdOut", type: "uint256" }] },
	{ type: "error", name: "ImplementationOnly", inputs: [] },
] as const
