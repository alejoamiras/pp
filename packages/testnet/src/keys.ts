import { KEY_NAMES, type KeyName, type KeySpec } from "./keyfile"

const spec = (...names: KeyName[]): KeySpec[] => names.map((n) => KEY_NAMES.find((k) => k.name === n) as KeySpec)

/** The names each command loads from the key file, and no other. */
export const RUN_KEYS = {
	fund: spec("L1_DEPLOYER_KEY"),
	"deploy-pool": spec("POOL_DEPLOYER_KEY"),
	asp: spec("ASP_POSTMAN_KEY"),
	deploy: spec("L1_DEPLOYER_KEY", "L2_DEPLOYER_SECRET"),
	open: spec("GUARDIAN_KEY"),
	pause: spec("GUARDIAN_KEY"),
	bot: spec("BOT_POSTER_SECRET", "BOT_INTAKE_SECRET"),
	seed: spec("CANARY_OWNER_KEY"),
	canary: spec("CANARY_OWNER_KEY", "CANARY_SENDER_KEY"),
	"canary-settle": spec("CANARY_SENDER_KEY"),
} as const satisfies Record<string, readonly KeySpec[]>

export type KeyedRun = keyof typeof RUN_KEYS
