import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { type Hex, parseAbi } from "viem"
import { afterAll, beforeAll, expect } from "vitest"
import { type BridgeClient, createBridgeClient } from "../../../../src/client/bridge-client"
import { prepareBridgeSpend } from "../../../../src/client/prepare"
import type { BridgeSession } from "../../../../src/client/session"
import type { PreparedBridgeSpend } from "../../../../src/client/types"
import { PROCESSOR_PORTAL_ABI } from "../../../../src/factory-abi"
import { memoryStore } from "../../../../src/test/client-fakes"
import { account, type Device, device, type Owner, owner, seedOf, sender, sessionOf } from "./actors"
import { attached, l1Client } from "./stack"
import { recordingTransport } from "./transport"

export const code = (p: Promise<unknown>) =>
	p.then(
		() => "resolved",
		(e: { code?: string; check?: string }) => (e.check ? `${e.code}:${e.check}` : e.code),
	)

const ASP_ROOT = parseAbi(["function latestASPRoot() view returns (uint256)"])

/**
 * One submit file's setup on the attached stack: a device that `name`'s hooks start and stop, the
 * per-case timings they print, and the helpers its cases share.
 */
export function submitKit(name: string) {
	const m = attached()
	const seed = seedOf(m)
	const chain = l1Client(m)
	const timings: Record<string, number> = {}
	let dev: Device

	beforeAll(async () => {
		dev = await device(m, name)
	})

	afterAll(async () => {
		await dev?.stop()
		console.log(`[${name}] timings ms: ${JSON.stringify(timings)}`)
	})

	/** One owner with notes, a client that has preflighted a recipient, and a sender over a recording transport. */
	async function bridgeCase(id: string, values: readonly bigint[]) {
		const t0 = performance.now()
		const o: Owner = await owner(m, seed, values)
		const session: BridgeSession = await sessionOf(m, o)
		const client: BridgeClient = createBridgeClient({ manifest: m, journal: memoryStore().store })
		const recipient = (await account(dev)).address
		await client.preflight({ recipient, wallet: dev.wallet })
		const wire = recordingTransport(m.l1Rpc)
		const l1 = await sender(m, wire.transport)
		const prepare = (i: number, amount: bigint, to = recipient) =>
			prepareBridgeSpend(session, { note: o.notes[i]!.commitment, amount, portal: m.bridge.portal, recipient: to })
		const unspent = async () => (await session.pool.notes()).filter((n) => n.status === "approved").map((n) => n.commitment)
		const done = () => (timings[id] = Math.round(performance.now() - t0))
		return { o, session, client, recipient, wire, l1, prepare, unspent, done }
	}

	/** Sends `s` to the portal from a sender of its own, outside the client. */
	async function landDirectly(s: PreparedBridgeSpend): Promise<Hex> {
		const other = await sender(m)
		const hash = await other.writeContract({
			address: m.bridge.portal,
			abi: PROCESSOR_PORTAL_ABI,
			functionName: "bridgeFromPool",
			args: [s.proof, s.noteData, s.secretHash],
			account: other.account!,
			chain: other.chain,
		})
		expect((await chain.waitForTransactionReceipt({ hash })).status).toBe("success")
		return hash
	}

	const aspRoot = () => chain.readContract({ address: m.pool.aspRegistry, abi: ASP_ROOT, functionName: "latestASPRoot" })

	/** Approves a label nobody holds and waits until the registry's root moved: every held proof's ASP root dies. */
	async function moveAspRoot(): Promise<void> {
		const before = await aspRoot()
		await seed.approveLabel(BigInt(Fr.random().toString()))
		for (let i = 0; (await aspRoot()) === before; i++) {
			if (i === 100) throw new Error("the ASP root did not move")
			await new Promise((r) => setTimeout(r, 100))
		}
	}

	return { m, seed, chain, dev: () => dev, bridgeCase, landDirectly, moveAspRoot }
}
