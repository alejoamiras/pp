/** The smoke battery, each check timed. The integration suite runs the same checks as tests; this is
 *  the CLI's one-shot form. */
import type { BridgeBlock, ManifestV2 } from "../../src/manifest-v2"
import { flowGenerationBindings, flowHubRegistrations } from "./bindings"
import type { SandboxClients } from "./handle"

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

/** Runs the whole battery and stops at the first failure. */
export async function runSmoke(clients: SandboxClients, manifest: ManifestV2): Promise<FlowResult[]> {
	const bridge = manifest.bridge as BridgeBlock
	const [usdc, usdt, pxo] = bridge.tokens
	if (!usdc || !usdt || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
	const results: FlowResult[] = []
	const step = async (label: string, fn: () => Promise<string>) => {
		const r = await timed(label, fn)
		results.push(r)
		if (!r.ok) throw new Error(r.line)
	}
	console.log("\n=== smoke ===")
	await step("generation bindings: vault, cap, paused entries, one portal per token", () => flowGenerationBindings(clients.l1, bridge))
	await step("hub registrations: deployed tokens bound to their portals, the portal-only one unregistered", () =>
		flowHubRegistrations({ wallet: clients.l2.wallet, from: clients.l2.relayer }, bridge, [usdc, usdt], [pxo]),
	)
	return results
}

export function durationTable(results: FlowResult[]): string {
	const width = Math.max(...results.map((r) => r.label.length))
	return results.map((r) => `${r.label.padEnd(width)}  ${r.seconds.toFixed(1).padStart(7)} s`).join("\n")
}
