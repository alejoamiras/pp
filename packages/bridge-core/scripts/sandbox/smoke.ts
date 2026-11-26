/** The smoke battery: every flow once on the base actor, in the order its state requires, each timed.
 *  The integration suite runs each flow on a fresh actor; this is the CLI's one-shot form. */
import type { ManifestV2 } from "../../src/manifest-v2"
import { buildContext, type SmokeContext, tokenBlockOf } from "./context"
import {
	flowConcurrentFirstClaims,
	flowGuardianPause,
	flowL1Pause,
	flowOutboxRoundTrip,
	flowPortalOnlyToken,
	flowPrivateDeposit,
	flowPublicDeposit,
	flowRejectedRegistration,
	flowRelayedPrivateDeposit,
	flowRelayerFirstRegister,
	runExit,
} from "./flows"
import type { SandboxClients } from "./handle"
import type { Actor } from "./l2"

export interface FlowResult {
	label: string
	ok: boolean
	seconds: number
	line: string
}

async function timed(label: string, fn: () => Promise<string>): Promise<FlowResult> {
	const t0 = Date.now()
	try {
		const line = `✅ ${label} — ${await fn()}`
		console.log(line)
		return { label, ok: true, seconds: (Date.now() - t0) / 1000, line }
	} catch (e) {
		const line = `✗ ${label} — ${e instanceof Error ? e.message : String(e)}`
		console.log(line)
		return { label, ok: false, seconds: (Date.now() - t0) / 1000, line }
	}
}

/** Runs the whole battery on one actor and stops at the first failure. */
export async function runSmoke(clients: SandboxClients, manifest: ManifestV2, actor: Actor): Promise<FlowResult[]> {
	const s: SmokeContext = await buildContext(clients, manifest, actor.address)
	const [usdc, , pxo] = s.bridge.tokens
	if (!usdc || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
	const usdcL2 = await s.l2TokenOf(tokenBlockOf(usdc))
	const unit = 10n ** BigInt(usdc.decimals)

	const results: FlowResult[] = []
	const step = async (label: string, fn: () => Promise<string>) => {
		const r = await timed(label, fn)
		results.push(r)
		if (!r.ok) throw new Error(r.line)
	}
	console.log("\n=== smoke ===")
	await step("public deposit → claim_public", () => flowPublicDeposit(s, usdc, usdcL2))
	await step("private deposit → claim_private", () => flowPrivateDeposit(s, usdc, usdcL2))
	await step("relayed private claim + wrong-recipient rejection", () => flowRelayedPrivateDeposit(s, usdc, usdcL2))
	await step("public exit → L1 withdraw", () => runExit(s, { token: usdc, l2Token: usdcL2, amount: 10n * unit, isPrivate: false }))
	await step("private exit → L1 withdraw", () => runExit(s, { token: usdc, l2Token: usdcL2, amount: 5n * unit, isPrivate: true }))
	await step("relayer registers before the depositor claims", () => flowRelayerFirstRegister(s))
	await step("two concurrent first-time deposits", () => flowConcurrentFirstClaims(s))
	await step("portal-only token registers on its first claim", () => flowPortalOnlyToken(s, pxo))
	await step("tampered registration rejected, then corrected", () => flowRejectedRegistration(s))
	await step("guardian pause blocks exits, not claims", () => flowGuardianPause(s, usdc))
	await step("factory pause: portals refuse deposits and withdraws first", () => flowL1Pause(s, usdc))
	await step("outbox: not consumed at proposal, consumed after finalization", () => flowOutboxRoundTrip(s, usdc, usdcL2))
	return results
}

export function durationTable(results: FlowResult[]): string {
	const width = Math.max(...results.map((r) => r.label.length))
	return results.map((r) => `${r.label.padEnd(width)}  ${r.seconds.toFixed(1).padStart(7)} s`).join("\n")
}
