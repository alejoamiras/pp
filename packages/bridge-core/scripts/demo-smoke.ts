/**
 * `bun run demo:smoke`: the first path once, end to end, on the local stack `PP_STACK_MANIFEST` names.
 * It seeds its own note of 100, then preflights a fresh account, bridges 70 to it, deploys the
 * account and claims in one sponsored transaction, ragequits the 70 and settles it, and checks that
 * the payee received exactly 70. Prints each step's time. Exits 0 on success, 1 on a failure and 2
 * when the manifest is not the local stack's.
 */
import { createPublicClient, erc20Abi, http } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createBridgeClient } from "../src/client/bridge-client"
import { BridgeClientError } from "../src/client/errors"
import { prepareBridgeSpend } from "../src/client/prepare"
import { localManifest, untilReady } from "./ragequit"
import { account, device, memoryJournal, owner, seedOf, send, sender, sessionOf } from "./stack-actors"

const DEPOSIT = 100n
const BRIDGED = 70n

async function smoke(m: ReturnType<typeof localManifest>, log: (line: string) => void): Promise<void> {
	const timed = async <T>(step: string, f: () => Promise<T>): Promise<T> => {
		const t0 = performance.now()
		const out = await f()
		log(`[smoke] ${step} ${Math.round(performance.now() - t0)} ms`)
		return out
	}
	const o = await timed("seed", () => owner(m, seedOf(m), [DEPOSIT]))
	const note = o.notes[0]!
	const session = await sessionOf(m, o)
	const client = createBridgeClient({ manifest: m, journal: memoryJournal() })
	const d = await device(m)
	try {
		const holder = await account(d)
		await timed("preflight", () => client.preflight({ recipient: holder.address, wallet: d.wallet }))
		const spend = await prepareBridgeSpend(session, {
			note: note.commitment,
			amount: BRIDGED,
			portal: m.bridge.portal,
			recipient: holder.address,
		})
		const bridged = await timed("bridge", async () => client.submit(spend, await sender(m), session))
		await timed("claimable", () => client.waitClaimable(bridged))
		await timed("deploy and claim", async () => holder.deployWith(await client.claimPayload(session, bridged)))
		const payee = privateKeyToAccount(generatePrivateKey()).address
		const burn = await timed("ragequit", async () =>
			send(d, holder.address, await client.ragequitPayload({ payee, amount: BRIDGED, label: note.label })),
		)
		const ticket = (await client.exitTickets({ payee })).find((t) => t.l2TxHash === burn.txHash.toString())
		if (!ticket) throw new Error("the ragequit left no ticket")
		await timed("ready", () => untilReady(client, ticket))
		await timed("settle", async () => client.settle(ticket, await sender(m)))
		const l1 = createPublicClient({ transport: http(m.l1Rpc) })
		const paid = await l1.readContract({ address: m.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [payee] })
		if (paid !== BRIDGED) throw new Error(`the payee received ${paid}, not ${BRIDGED}`)
		log(`[smoke] passed: ${BRIDGED} bridged, claimed, ragequit and settled to a fresh payee`)
	} finally {
		await d.stop()
	}
}

export async function main(env: Record<string, string | undefined>, log = console.log): Promise<number> {
	let m: ReturnType<typeof localManifest>
	try {
		m = localManifest(env.PP_STACK_MANIFEST)
	} catch (e) {
		console.error(`[smoke] ${e instanceof Error ? e.message : "refused"}`)
		return 2
	}
	try {
		await smoke(m, log)
		return 0
	} catch (e) {
		const why =
			e instanceof BridgeClientError ? `${e.code}${e.source ? ` (${e.source})` : ""}` : e instanceof Error ? e.message : "failed"
		console.error(`[smoke] failed: ${why.split("\n")[0]}`)
		return 1
	}
}

if (import.meta.main) process.exit(await main(process.env))
