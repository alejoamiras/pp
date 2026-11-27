import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import type { LabelPath } from "@pp/bridge-spec"
import { type AspSnapshot, labelState, parseAspSnapshot, pathFor, readRootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { settled } from "../../../scripts/sandbox/context"
import { labelledTokenArtifact } from "../../../src/artifacts"
import { callPayload, sponsored } from "../../../src/client/payload"
import { account, labelRows, publicBalance, send } from "./support/actors"
import { exitKit } from "./support/exit-kit"

const k = exitKit("births")
const POOL = 0
const BIRTH = 1
/** The bot ticks on each Aztec block and at least every 30 s; the births job allows the same bound. */
const APPROVAL_MS = 180_000
/** Chain seconds a checked spend may take from the tip to its anchored proof landing: a few slots. */
const PROVING_BUDGET_SEC = 300n

const pathArg = (p: LabelPath) => ({ index: p.index, depth: p.depth, siblings: [...p.siblings] })
const byOrigin = (rows: [bigint, number, bigint][]) => [...rows].sort((a, b) => a[1] - b[1])

describe("births", () => {
	const bot = k.m.bot
	const registry = k.m.bridge.registry
	const snapshot = async (at: "latest" | bigint): Promise<AspSnapshot> => {
		if (!bot) throw new Error("the stack runs no bot")
		return parseAspSnapshot(await (await fetch(`${bot.url}/v1/snapshots/${at}`)).json())
	}
	const record = (at: number) => readRootRecord({ aztecNode: k.m.aztecNode, registry, at })
	const timeAt = async (n: number) => (await k.dev().node.getBlockData(n as never))?.header.globalVariables.timestamp ?? 0n
	const tokenCall = (name: string, args: unknown[]): Promise<ExecutionPayload> =>
		callPayload(labelledTokenArtifact, AztecAddress.fromStringUnsafe(k.m.bridge.token), name, args).then(sponsored)

	/**
	 * The bot's path for `label` once the record at the tip and the bot's latest snapshot hold the same
	 * roots and the label is spendable there with the proving budget to spare: what a client checks
	 * before a checked spend.
	 */
	async function activePath(label: bigint, origin: typeof POOL | typeof BIRTH, what: string): Promise<LabelPath> {
		const read = async () => {
			const tip = Number(await k.dev().node.getBlockNumber())
			const [r, s, t] = await Promise.all([record(tip), snapshot("latest"), timeAt(tip)])
			return labelState(r, s, label, origin, t + PROVING_BUDGET_SEC) === "ACTIVE" ? pathFor(s, label, origin) : null
		}
		return (await settled(read, (p) => p !== null, what, APPROVAL_MS)) as LabelPath
	}

	it("BT1 a bridged note unshields, shields back under a birth label the stack's bot approves, and the born note passes a checked transfer", async () => {
		await k.timed("BT1", async () => {
			const { holder, label } = await k.claimed(100n, [60n])
			const dev = k.dev()
			const from = holder.address

			const pool = await activePath(label, POOL, "the pool label ACTIVE on the bot's snapshot")
			await send(dev, from, await tokenCall("unshield", [25n, new Fr(label), pathArg(pool)]))
			expect([await labelRows(dev, from), await publicBalance(dev, from)]).toEqual([[[label, POOL, 35n]], 25n])

			const shield = await send(dev, from, await tokenCall("shield", [25n]))
			const rows = await settled(
				() => labelRows(dev, from),
				(r) => r.some(([, o]) => o === BIRTH),
				"the born note",
			)
			const born = rows.find(([, o]) => o === BIRTH)?.[0] as bigint
			expect(byOrigin(rows)).toEqual([
				[label, POOL, 35n],
				[born, BIRTH, 25n],
			])
			expect(await publicBalance(dev, from)).toBe(0n)

			// The record current at the shield's own block cannot hold the birth that block made.
			const shieldBlock = Number(shield.blockNumber)
			const before = await record(shieldBlock)
			expect(labelState(before, await snapshot(before.sequence), born, BIRTH, await timeAt(shieldBlock))).toBe("ABSENT")

			const path = await activePath(born, BIRTH, "the bot's approval of the birth")
			const to = (await account(dev)).address
			// A well-formed path one level too deep reconstructs another root: the birth tree is checked.
			const wrong = { index: path.index, depth: path.depth + 1, siblings: path.siblings.map((s, i) => (i === path.depth ? 1n : s)) }
			const token = await Contract.at(dev.token, labelledTokenArtifact, dev.wallet as never)
			await expect(token.methods.transfer_private(to, 25n, born, wrong).simulate({ from } as never)).rejects.toThrow(/NotMember/)

			await send(dev, from, await tokenCall("transfer_private", [to, 25n, new Fr(born), pathArg(path)]))
			expect(await labelRows(dev, from)).toEqual([[label, POOL, 35n]])
			const received = await settled(
				() => labelRows(dev, to),
				(r) => r.length > 0,
				"the recipient's born note",
			)
			expect(received).toEqual([[born, BIRTH, 25n]])
		})
	})
})
