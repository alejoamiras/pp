import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type LabelPath, labelState, parseAspSnapshot, pathFor, readRootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { labelledTokenArtifact } from "../../../src/artifacts"
import { callPayload, sponsored } from "../../../src/client/payload"
import { labelBalance, send, sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"

const k = exitKit("public-exit")
const POOL_ORIGIN = 0
const POST_TIMEOUT_MS = 180_000

/**
 * The pool tree's path for `label` from the bot's snapshot of the registry's latest record, once a
 * post holds the label and is young enough for a checked spend.
 */
async function poolPath(label: bigint): Promise<LabelPath> {
	const { m } = k
	if (!m.bot) throw new Error("the attached stack runs no bot")
	const node = k.dev().node
	for (const end = Date.now() + POST_TIMEOUT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 1_000))) {
		const head = await node.getBlockData("latest")
		if (!head) continue
		const record = await readRootRecord({
			aztecNode: m.aztecNode,
			registry: m.bridge.registry as `0x${string}`,
			at: Number(head.header.globalVariables.blockNumber),
		})
		const res = await fetch(`${m.bot.url}/v1/snapshots/${record.sequence}`)
		if (!res.ok) continue
		const snapshot = parseAspSnapshot(await res.json())
		if (labelState(record, snapshot, label, POOL_ORIGIN, head.header.globalVariables.timestamp) !== "ACTIVE") continue
		const path = pathFor(snapshot, label, POOL_ORIGIN)
		if (path) return path
	}
	throw new Error(`no registry post admitted label ${label} within ${POST_TIMEOUT_MS} ms`)
}

async function publicBalance(holder: AztecAddress): Promise<bigint> {
	const dev = k.dev()
	const token = await Contract.at(dev.token, labelledTokenArtifact, dev.wallet as never)
	const r = (await token.methods.balance_of_public(holder).simulate({ from: holder } as never)) as unknown
	return BigInt(((r as { result?: unknown }).result ?? r) as bigint)
}

describe("public exit", () => {
	it("X1 unshields 25 of a claimed 40, exits that public balance through the client, and settles exactly 25", async () => {
		await k.timed("X1", async () => {
			const { client, holder, label } = await k.claimed(100n, [40n])
			const dev = k.dev()
			const path = await poolPath(label)
			const arg = { index: path.index, depth: path.depth, siblings: [...path.siblings] }
			const unshield = await callPayload(labelledTokenArtifact, dev.token, "unshield", [25n, new Fr(label), arg])
			await send(dev, holder.address, await sponsored(unshield))
			expect(await labelBalance(dev, holder.address, label)).toBe(15n)
			expect(await publicBalance(holder.address)).toBe(25n)

			const payee = freshPayee()
			const burn = await send(dev, holder.address, await client.exitPublicPayload({ payee, amount: 25n }))
			expect(await publicBalance(holder.address)).toBe(0n)

			const [ticket, ...rest] = await client.exitTickets({ payee })
			expect(rest).toEqual([])
			expect(ticket).toMatchObject({ kind: "public", payee, amount: 25n, l2TxHash: burn.txHash.toString() })
			await k.until(client, ticket!, "ready")
			await client.settle(ticket!, await sender(k.m))
			expect(await k.balanceOf(payee)).toBe(25n)
			expect(await client.exitStatus(ticket!)).toBe("settled")
		})
	})
})
