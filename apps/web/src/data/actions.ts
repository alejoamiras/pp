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

/** Why `action` cannot be dispatched, for the disabled button's reason; `null` when it can. */
export function dispatchRefusal(
	grant: Grant | null,
	action: AztecAction,
	stage: Stage,
	t: CapabilityTargets,
): "STAGE_UNSUPPORTED" | "NOT_GRANTED" | null {
	if (!inStage(action, stage)) return "STAGE_UNSUPPORTED"
	return canDispatch(grant, action, stage, t) ? null : "NOT_GRANTED"
}

/**
 * The actions each port member runs, the reads it makes before its handoff included; a member needs
 * every one, so a partial grant refuses here rather than in the wallet's simulation.
 */
const PORT_ACTIONS: Record<keyof AztecPort, readonly AztecAction[]> = {
	balancesByLabel: ["balances"],
	notesByLabel: ["notes"],
	publicBalance: ["publicBalance"],
	transferPrivate: ["transferPrivate", "notes"],
	unshield: ["unshield", "notes"],
	shield: ["shield"],
	ragequit: ["ragequit", "notes"],
	exitPublic: ["exitPublic", "publicBalance"],
	unshieldAndExit: ["unshield", "exitPublic", "notes"],
}

/** `port` behind the dispatch check; `allowed` is read at each call, so a new grant applies at once. */
export function guardAztec(port: AztecPort, allowed: (action: AztecAction) => boolean): AztecPort {
	const guard = <K extends keyof AztecPort>(name: K): AztecPort[K] =>
		((...args: unknown[]) => {
			const refused = PORT_ACTIONS[name].find((a) => !allowed(a))
			if (refused !== undefined) return Promise.reject(new NotGrantedError(refused))
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
		unshieldAndExit: guard("unshieldAndExit"),
	}
}
