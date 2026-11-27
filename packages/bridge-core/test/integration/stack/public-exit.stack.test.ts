import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
	type Hex,
	type LabelPath,
	labelState,
	parseAspSnapshot,
	pathFor,
	RegistryAddressError,
	readRootRecord,
	SnapshotError,
} from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { labelledTokenArtifact } from "../../../src/artifacts"
import { callPayload, sponsored } from "../../../src/client/payload"
import { labelBalance, send, sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"

const k = exitKit("public-exit")
const POOL_ORIGIN = 0
const POST_TIMEOUT_MS = 180_000

/** One read of the latest record and the bot's snapshot of it: the label's pool path once that record admits it. */
async function admitted(bot: string, label: bigint, deadline: number): Promise<LabelPath | null> {
	const head = await k.dev().node.getBlockData("latest")
	if (!head) return null
	const { blockNumber, timestamp } = head.header.globalVariables
	const record = await readRootRecord({ aztecNode: k.m.aztecNode, registry: k.m.bridge.registry as Hex, at: Number(blockNumber) })
	const res = await fetch(`${bot}/v1/snapshots/${record.sequence}`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
	if (!res.ok) return null
	const snapshot = parseAspSnapshot(await res.json())
	return labelState(record, snapshot, label, POOL_ORIGIN, timestamp) === "ACTIVE" ? pathFor(snapshot, label, POOL_ORIGIN) : null
}

/** `p`, or a rejection at `deadline`: the node client's reads carry no deadline of their own. */
function by<T>(deadline: number, p: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("the poll outlasted the deadline")), Math.max(1, deadline - Date.now()))
	})
	return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/**
 * The pool tree's path for `label`, once a post holds it and is young enough for a checked spend.
 * A malformed snapshot (bad JSON or a bad shape) or a bad registry address ends the wait; any other
 * failure is retried.
 */
async function poolPath(label: bigint): Promise<LabelPath> {
	const bot = k.m.bot?.url
	if (!bot) throw new Error("the attached stack runs no bot")
	const deadline = Date.now() + POST_TIMEOUT_MS
	let last: unknown
	while (Date.now() < deadline) {
		try {
			const path = await by(deadline, admitted(bot, label, deadline))
			if (path) return path
		} catch (e) {
			if (e instanceof SnapshotError || e instanceof RegistryAddressError || e instanceof SyntaxError) throw e
			last = e
		}
		await new Promise((r) => setTimeout(r, 1_000))
	}
	throw new Error(`no registry post admitted label ${label} within ${POST_TIMEOUT_MS} ms`, { cause: last })
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
			// The unshield proves the path against the record at its anchor, and its public step checks
			// those roots again: both hold only while no other label is approved. The suite runs one file
			// at a time and every approval is an actor's own call, so none lands in between.
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
