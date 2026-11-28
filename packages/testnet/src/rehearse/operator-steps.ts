/**
 * The operator-fork rehearsal's steps, in the order it runs them; it fails unless it ran exactly these.
 * Imports nothing, so `rehearse <target> --list` reads it without the pool checkout.
 */
export const OPERATOR_FORK_STEPS = [
	"fund",
	"verify-deployment --pool-only",
	"seed, no asset",
	"seed --no-register, unregistered",
	"seed",
	"seed --no-register",
	"seed, operator block moved",
	"bot leaves",
] as const

export type OperatorForkStep = (typeof OPERATOR_FORK_STEPS)[number]
