/**
 * One-shot faults a test arms through `__ppFixtures`. Each op names the call it hits:
 *
 * - `preflight`, `prove`, `submit`: throw the code before anything is sent (`submit` with `UNCERTAIN`
 *   also journals a record with no hash for the note, so later submits need `acceptUncertain`).
 * - `send`: at the Ethereum send, `REVERTED` (mined and reverted, note unspent), `REJECTED` (the
 *   wallet says no), `LOST` (the request fails with no code, so it may have gone out) or `PENDING` (a
 *   hash that is never mined); `hangNext("send")` is a wallet that never answers, leaving the journal
 *   record without a transaction hash.
 * - `claim` and the token calls: `REJECTED` (the wallet says no), `REVERTED`, `DROPPED` or `UNCONFIRMED`
 *   (sent, with an outcome the page could not read).
 * - `open`, `settle`: throw the code.
 * - `register`: the registration step throws the code; its calls take the `send` faults, `REVERTED`
 *   and `PENDING` at the receipt.
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
	"unshieldAndExit",
	"settle",
	"register",
] as const

export type FixtureOp = (typeof FIXTURE_OPS)[number]

export const isFixtureOp = (op: unknown): op is FixtureOp => (FIXTURE_OPS as readonly unknown[]).includes(op)
