/**
 * The action layer: an Aztec call goes out only when the stage's request named it and the wallet's
 * answer granted every scope it needs. A refusal throws before the port is called.
 */
import { type AztecAction, actionContract, type CapabilityTargets, inStage, requiredScopes } from "./capabilities"
import type { AztecPort, Stage } from "./ports"
import type { Grant } from "./wallet/types"

export class NotGrantedError extends Error {
	readonly code = "NOT_GRANTED"
	constructor(readonly action: AztecAction) {
		super(`the wallet did not grant ${action}`)
		this.name = "NotGrantedError"
	}
}

/**
 * Whether `action` may be dispatched. A `Grant` holds only requested scopes, so this is "requested and
 * granted"; the stage check keeps an action the stage never requests closed even under an odd grant.
 */
export function canDispatch(grant: Grant | null, action: AztecAction, stage: Stage, t: CapabilityTargets): boolean {
	if (grant === null || !inStage(action, stage)) return false
	if (!grant.contracts.includes(actionContract(action, t))) return false
	return requiredScopes(action, t).every((k) => grant.scopes.has(k))
}

const PORT_ACTION: Record<keyof AztecPort, AztecAction> = {
	balancesByLabel: "balances",
	notesByLabel: "notes",
	publicBalance: "publicBalance",
	transferPrivate: "transferPrivate",
	unshield: "unshield",
	shield: "shield",
	ragequit: "ragequit",
	exitPublic: "exitPublic",
}

/** `port` behind the dispatch check; `allowed` is read at each call, so a new grant applies at once. */
export function guardAztec(port: AztecPort, allowed: (action: AztecAction) => boolean): AztecPort {
	const guard = <K extends keyof AztecPort>(name: K): AztecPort[K] =>
		((...args: unknown[]) => {
			const action = PORT_ACTION[name]
			if (!allowed(action)) return Promise.reject(new NotGrantedError(action))
			return (port[name] as (...a: unknown[]) => Promise<unknown>).apply(port, args)
		}) as AztecPort[K]
	return {
		balancesByLabel: guard("balancesByLabel"),
		notesByLabel: guard("notesByLabel"),
		publicBalance: guard("publicBalance"),
		transferPrivate: guard("transferPrivate"),
		unshield: guard("unshield"),
		shield: guard("shield"),
		ragequit: guard("ragequit"),
		exitPublic: guard("exitPublic"),
	}
}
