/**
 * The capability request for each deployment stage, built from the deployment's addresses, and the
 * scopes each app action needs. Exact addresses and function names only: the app never asks for `"*"`.
 *
 * Placement follows the wallet's routing: `#[external("utility")]` reads under `simulation.utilities`;
 * public views and every send's dry run under `simulation.transactions`; sends, and the fee
 * contract's `sponsor_unconditionally` that rides in each of them, under `transaction`. The fee
 * contract is called, never registered, so it stays out of `contracts`.
 */
import type { AztecAddress } from "./stack-types"
import type { Stage } from "./ports"
import { type ScopeBucket, scopeKey } from "./wallet/grant"

export interface CapabilityTargets {
	readonly hub: AztecAddress
	readonly token: AztecAddress
	readonly sponsoredFpc: AztecAddress
}

export interface FunctionScope {
	contract: AztecAddress
	function: string
}

export interface Manifest {
	version: "1.0"
	metadata: { name: "pp"; version: string }
	capabilities: [
		{ type: "accounts"; canGet: true; canCreateAuthWit: false },
		{ type: "contracts"; contracts: AztecAddress[]; canRegister: true; canGetMetadata: true },
		{ type: "simulation"; transactions: { scope: FunctionScope[] }; utilities: { scope: FunctionScope[] } },
		{ type: "transaction"; scope: FunctionScope[] },
	]
}

/** Everything the app does on Aztec; dispatch refuses an action whose scopes were not all granted. */
export type AztecAction =
	| "balances"
	| "notes"
	| "claim"
	| "ragequit"
	| "publicBalance"
	| "transferPrivate"
	| "unshield"
	| "exitPublic"
	| "shield"

type Contract = "hub" | "token"
interface ActionSpec {
	stage: Stage
	contract: Contract
	fn: string
	kind: "utility" | "view" | "send"
}

/** In request order. */
const ACTIONS: Record<AztecAction, ActionSpec> = {
	balances: { stage: "2a", contract: "token", fn: "private_balances_by_label", kind: "utility" },
	notes: { stage: "2a", contract: "token", fn: "private_notes_by_label", kind: "utility" },
	claim: { stage: "2a", contract: "hub", fn: "claim_from_pool", kind: "send" },
	ragequit: { stage: "2a", contract: "hub", fn: "ragequit", kind: "send" },
	publicBalance: { stage: "2b", contract: "token", fn: "balance_of_public", kind: "view" },
	transferPrivate: { stage: "2b", contract: "token", fn: "transfer_private", kind: "send" },
	unshield: { stage: "2b", contract: "token", fn: "unshield", kind: "send" },
	exitPublic: { stage: "2b", contract: "hub", fn: "exit_public", kind: "send" },
	shield: { stage: "2c", contract: "token", fn: "shield", kind: "send" },
}

const STAGE_ORDER: Record<Stage, number> = { "2a": 0, "2b": 1, "2c": 2 }
const SPONSOR = "sponsor_unconditionally"

export const inStage = (action: AztecAction, stage: Stage): boolean => STAGE_ORDER[ACTIONS[action].stage] <= STAGE_ORDER[stage]

function actionsOf(stage: Stage): AztecAction[] {
	return (Object.keys(ACTIONS) as AztecAction[]).filter((a) => inStage(a, stage))
}

/** The scopes one action needs, each as `scopeKey`; a send also needs the sponsor in both buckets. */
export function requiredScopes(action: AztecAction, t: CapabilityTargets): string[] {
	const { contract, fn, kind } = ACTIONS[action]
	const at = t[contract]
	if (kind === "utility") return [scopeKey("simulation.utilities", at, fn)]
	if (kind === "view") return [scopeKey("simulation.transactions", at, fn)]
	const both = (c: AztecAddress, f: string): string[] => [scopeKey("simulation.transactions", c, f), scopeKey("transaction", c, f)]
	return [...both(at, fn), ...both(t.sponsoredFpc, SPONSOR)]
}

/** The contract an action calls; it must be in the granted `contracts` too. */
export const actionContract = (action: AztecAction, t: CapabilityTargets): AztecAddress => t[ACTIONS[action].contract]

function scopesIn(bucket: ScopeBucket, stage: Stage, t: CapabilityTargets): FunctionScope[] {
	const out: FunctionScope[] = []
	for (const a of actionsOf(stage)) {
		const { contract, fn, kind } = ACTIONS[a]
		const wanted =
			bucket === "simulation.utilities" ? kind === "utility" : bucket === "transaction" ? kind === "send" : kind !== "utility"
		if (wanted) out.push({ contract: t[contract], function: fn })
	}
	if (bucket !== "simulation.utilities") out.push({ contract: t.sponsoredFpc, function: SPONSOR })
	return out
}

/** The request a wallet sees at connect for `stage`. */
export function stageManifest(stage: Stage, t: CapabilityTargets): Manifest {
	return {
		version: "1.0",
		metadata: { name: "pp", version: "0.1.0" },
		capabilities: [
			{ type: "accounts", canGet: true, canCreateAuthWit: false },
			{ type: "contracts", contracts: [t.hub, t.token], canRegister: true, canGetMetadata: true },
			{
				type: "simulation",
				transactions: { scope: scopesIn("simulation.transactions", stage, t) },
				utilities: { scope: scopesIn("simulation.utilities", stage, t) },
			},
			{ type: "transaction", scope: scopesIn("transaction", stage, t) },
		],
	}
}
