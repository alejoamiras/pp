import type { KeySpec } from "./guards"

/** Each keyed run's variables, without the `PP_TESTNET_` prefix; `env/<run>.env.example` names exactly these. */
export const RUN_KEYS = {
	"deploy-pool": [{ name: "POOL_DEPLOYER_KEY", kind: "l1" }],
	asp: [{ name: "ASP_POSTMAN_KEY", kind: "l1" }],
	deploy: [
		{ name: "L1_DEPLOYER_KEY", kind: "l1" },
		{ name: "L2_DEPLOYER_SECRET", kind: "l2" },
	],
	open: [{ name: "GUARDIAN_KEY", kind: "l1" }],
	pause: [{ name: "GUARDIAN_KEY", kind: "l1" }],
	bot: [{ name: "BOT_POSTER_SECRET", kind: "l2" }],
	"bot-shields": [
		{ name: "BOT_POSTER_SECRET", kind: "l2" },
		{ name: "BOT_INTAKE_SECRET", kind: "l2" },
	],
	seed: [{ name: "CANARY_OWNER_KEY", kind: "l1" }],
	canary: [
		{ name: "CANARY_OWNER_KEY", kind: "l1" },
		{ name: "CANARY_SENDER_KEY", kind: "l1" },
	],
	"canary-settle": [{ name: "CANARY_SENDER_KEY", kind: "l1" }],
} as const satisfies Record<string, readonly KeySpec[]>

export type KeyedRun = keyof typeof RUN_KEYS

/** The 1Password item every template refers to. */
export const ITEM = "op://Keyed-Runs/PP-Testnet"
