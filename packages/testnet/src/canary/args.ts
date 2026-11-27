import type { Hex } from "viem"
import { GuardError, type Mode } from "../guards"

export type CanaryArgs = { kind: "run"; minSequence: bigint; post: Hex } | { kind: "settle"; burns: Hex[] }

export const CANARY_OPTIONS = {
	"min-sequence": { type: "string" },
	post: { type: "string" },
	settle: { type: "boolean" },
} as const

const HASH = /^0x[0-9a-fA-F]{64}$/
const POSITIVE = /^[1-9][0-9]*$/

/**
 * The canary's public arguments, read before the deployment file or any key: `--min-sequence` and
 * `--post` for a run, or `--settle` with burn hashes. No argument value is echoed into a refusal.
 * @throws GuardError `argv`
 */
export function canaryArgs(
	mode: Mode,
	values: { "min-sequence"?: unknown; post?: unknown; settle?: unknown },
	rest: readonly string[],
): CanaryArgs {
	// The testnet node follows real Sepolia, so a fork's bridge never reaches it.
	if (mode.kind === "rehearse-fork")
		throw new GuardError("argv", "the canary runs live or on the local stack (--rehearse), never on a fork")
	if (values.settle === true) return settleArgs(values, rest)
	if (rest.length) throw new GuardError("argv", "unexpected positional arguments; burn hashes go with --settle")
	const s = values["min-sequence"]
	if (typeof s !== "string" || !POSITIVE.test(s))
		throw new GuardError("argv", "--min-sequence takes the bot's first post's sequence, a positive decimal")
	const post = values.post
	if (typeof post !== "string" || !HASH.test(post))
		throw new GuardError("argv", "--post takes the bot's first post's L2 transaction hash")
	return { kind: "run", minSequence: BigInt(s), post: post.toLowerCase() as Hex }
}

function settleArgs(values: { "min-sequence"?: unknown; post?: unknown }, rest: readonly string[]): CanaryArgs {
	if (values["min-sequence"] !== undefined || values.post !== undefined)
		throw new GuardError("argv", "--settle takes burn hashes only, not --min-sequence or --post")
	if (rest.length === 0) throw new GuardError("argv", "--settle takes one or more L2 transaction hashes")
	const bad = rest.findIndex((h) => !HASH.test(h))
	if (bad >= 0) throw new GuardError("argv", `burn hash ${bad + 1} is not a 32-byte 0x hash`)
	const burns = rest.map((h) => h.toLowerCase() as Hex)
	if (new Set(burns).size !== burns.length) throw new GuardError("argv", "a burn hash is listed twice")
	return { kind: "settle", burns }
}
