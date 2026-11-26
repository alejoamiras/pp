/**
 * One-shot faults a test arms through `__ppFixtures`. Each op names the call it hits:
 *
 * - `preflight`, `prove`, `submit`: throw the code before anything is sent (`submit` with `UNCERTAIN`
 *   also marks the note, so later submits need `acceptUncertain`).
 * - `send`: at the Ethereum send, `REVERTED` (mined and reverted, note unspent) or `REJECTED` (the
 *   wallet says no); `hangNext("send")` is a wallet that never answers, leaving the journal record
 *   without a transaction hash.
 * - `claim` and the token calls: `REJECTED` (the wallet says no), `REVERTED` or `DROPPED`.
 * - `open`, `settle`: throw the code.
 */
export const FIXTURE_OPS = [
	"open",
	"preflight",
	"prove",
	"submit",
	"send",
	"claim",
	"transferPrivate",
	"unshield",
	"shield",
	"ragequit",
	"exitPublic",
	"settle",
] as const

export type FixtureOp = (typeof FIXTURE_OPS)[number]

export const isFixtureOp = (op: unknown): op is FixtureOp => (FIXTURE_OPS as readonly unknown[]).includes(op)
