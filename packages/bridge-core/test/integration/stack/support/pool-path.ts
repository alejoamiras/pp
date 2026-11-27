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
import type { Device } from "./actors"
import type { AttachedStack } from "./stack"

const POOL_ORIGIN = 0
const POST_TIMEOUT_MS = 180_000

/** One read of the latest record and the bot's snapshot of it: the label's pool path once that record admits it. */
async function admitted(m: AttachedStack, dev: Device, bot: string, label: bigint, deadline: number): Promise<LabelPath | null> {
	const head = await dev.node.getBlockData("latest")
	if (!head) return null
	const { blockNumber, timestamp } = head.header.globalVariables
	const record = await readRootRecord({ aztecNode: m.aztecNode, registry: m.bridge.registry as Hex, at: Number(blockNumber) })
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
 * failure is retried. A checked spend proven on this path holds only while no other label is
 * approved: its public step compares the roots again at inclusion.
 */
export async function poolPath(m: AttachedStack, dev: Device, label: bigint): Promise<LabelPath> {
	const bot = m.bot?.url
	if (!bot) throw new Error("the attached stack runs no bot")
	const deadline = Date.now() + POST_TIMEOUT_MS
	let last: unknown
	while (Date.now() < deadline) {
		try {
			const path = await by(deadline, admitted(m, dev, bot, label, deadline))
			if (path) return path
		} catch (e) {
			if (e instanceof SnapshotError || e instanceof RegistryAddressError || e instanceof SyntaxError) throw e
			last = e
		}
		await new Promise((r) => setTimeout(r, 1_000))
	}
	throw new Error(`no registry post admitted label ${label} within ${POST_TIMEOUT_MS} ms`, { cause: last })
}
