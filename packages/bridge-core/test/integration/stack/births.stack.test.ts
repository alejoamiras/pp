import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { aspLeaf, type LabelPath } from "@pp/bridge-spec"
import { type AspSnapshot, labelState, parseAspSnapshot, pathFor, readRootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { settled } from "../../../scripts/sandbox/context"
import { labelledTokenArtifact } from "../../../src/artifacts"
import { callPayload, sponsored } from "../../../src/client/payload"
import { account, labelBalance, labelRows, publicBalance, send } from "./support/actors"
import { exitKit } from "./support/exit-kit"

const k = exitKit("births")
const POOL = 0
const BIRTH = 1
/** The bot posts on the Aztec block after it sees a birth checkpointed; the births job allows the same. */
const APPROVAL_MS = 180_000

const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })

describe("births", () => {
	const bot = k.m.bot
	const registry = k.m.bridge.registry
	const snapshot = async (at: "latest" | bigint): Promise<AspSnapshot> => {
		if (!bot) throw new Error("the stack runs no bot")
		return parseAspSnapshot(await (await fetch(`${bot.url}/v1/snapshots/${at}`)).json())
	}
	const record = (at?: number) => readRootRecord({ aztecNode: k.m.aztecNode, registry, ...(at === undefined ? {} : { at }) })
	const timeAt = async (n: number) => (await k.dev().node.getBlockData(n as never))?.header.globalVariables.timestamp ?? 0n
	const tokenCall = (name: string, args: unknown[]): Promise<ExecutionPayload> =>
		callPayload(labelledTokenArtifact, AztecAddress.fromStringUnsafe(k.m.bridge.token), name, args).then(sponsored)

	it("BT1 a bridged note unshields, shields back under a birth label the stack's bot approves, and the born note passes a checked transfer", async () => {
		await k.timed("BT1", async () => {
			const { holder, label } = await k.claimed(100n, [60n])
			const dev = k.dev()
			const from = holder.address

			const pool = await settled(
				() => snapshot("latest"),
				(s) => pathFor(s, label, POOL) !== null,
				"the pool label in the bot's snapshot",
			)
			await send(dev, from, await tokenCall("unshield", [25n, new Fr(label), pathArg(pathFor(pool, label, POOL) as LabelPath)]))
			expect([await labelBalance(dev, from, label), await publicBalance(dev, from)]).toEqual([35n, 25n])

			const shield = await send(dev, from, await tokenCall("shield", [25n]))
			const rows = await settled(
				() => labelRows(dev, from),
				(r) => r.some(([, o]) => o === BIRTH),
				"the born note",
			)
			const born = rows.find(([, o]) => o === BIRTH) as [bigint, number, bigint]
			expect(born[2]).toBe(25n)
			expect(await publicBalance(dev, from)).toBe(0n)

			// The record current at the shield's own block cannot hold the birth that block made.
			const shieldBlock = Number(shield.blockNumber)
			const before = await record(shieldBlock)
			expect(labelState(before, await snapshot(before.sequence), born[0], BIRTH, await timeAt(shieldBlock))).toBe("ABSENT")

			const snap = await settled(
				() => snapshot("latest"),
				(s) => s.birthLeaves.includes(aspLeaf(born[0])),
				"the bot's approval of the birth",
				APPROVAL_MS,
			)
			const after = await record()
			expect([after.birthRoot, after.poolRoot]).toEqual([snap.birthRoot, snap.poolRoot])
			const tip = Number(await dev.node.getBlockNumber())
			expect(labelState(after, snap, born[0], BIRTH, await timeAt(tip))).toBe("ACTIVE")

			const to = (await account(dev)).address
			const path = pathFor(snap, born[0], BIRTH) as LabelPath
			await send(dev, from, await tokenCall("transfer_private", [to, 25n, new Fr(born[0]), pathArg(path)]))
			expect(await labelBalance(dev, from, born[0])).toBe(0n)
			const received = await settled(
				() => labelRows(dev, to),
				(r) => r.length > 0,
				"the recipient's born note",
			)
			expect(received).toEqual([[born[0], BIRTH, 25n]])
		})
	})
})
