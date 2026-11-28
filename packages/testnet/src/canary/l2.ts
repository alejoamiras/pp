/** The canary's L2 sends: each recorded before its broadcast, sent once, and required to land. */
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { type Account, type Device, type ProvenTx, type SendOutcome, sendAndWait } from "@pp/bridge-core/account"
import type { LabelPath, Origin } from "@pp/label-paths"
import { report } from "../cli/common"
import { type CheckedSpend, checkedSpend } from "../checked-transfer"
import { CanaryError } from "../report"
import type { TokenView } from "../token"
import { type CanaryContext, L2_WAIT_TIMEOUT_SEC } from "./context"
import type { BlockRef } from "../checked-transfer"

/** The canary's fresh account, its device and its view of the token. */
export type Holder = { device: Device; account: Account; token: TokenView }

/** Chain seconds between the tip a path is read at and the anchor its proof takes. */
export const PROVING_BUDGET_SEC = 120n

/**
 * Sends `proven` once. Its hash enters the report before the broadcast, its timings and outcome after.
 * @returns the outcome, whatever it is
 */
export async function sendProven(c: CanaryContext, step: string, proven: ProvenTx, provingMs?: number): Promise<SendOutcome> {
	const entry: Record<string, string | number | undefined> = {
		step,
		txHash: proven.txHash.toString(),
		provingMs: provingMs && Math.round(provingMs),
	}
	c.report.push("sends", entry)
	c.report.flush()
	const out = await sendAndWait(c.node, proven, { l2WaitTimeoutSec: L2_WAIT_TIMEOUT_SEC })
	entry.inclusionMs = out.proposedMs
	entry.checkpointMs = out.proposedMs === undefined ? undefined : out.ms - out.proposedMs
	entry.outcome = out.status === "unresolved" ? `unresolved-${out.reason}` : out.status
	c.report.flush()
	report("l2-sent", { step, txHash: entry.txHash as string, outcome: entry.outcome })
	return out
}

/**
 * @throws CanaryError naming `step` unless `out` is checkpointed and successful
 */
export function landed(out: SendOutcome, step: string): asserts out is SendOutcome & { status: "checkpointed" } {
	if (out.status === "checkpointed") return
	const errorClass = out.status === "reverted" ? "REVERTED" : `UNRESOLVED_${out.reason.toUpperCase()}`
	throw new CanaryError("FAILED", errorClass, `${step} in L2 tx ${out.txHash}`)
}

/** Proves `payload` from the holder, then sends it once and requires it to land. */
export async function proveAndLand(c: CanaryContext, h: Holder, step: string, payload: ExecutionPayload): Promise<SendOutcome> {
	const t0 = performance.now()
	const proven = await h.account.prove(payload)
	const out = await sendProven(c, step, proven, performance.now() - t0)
	landed(out, step)
	return out
}

function recordChecks(c: CanaryContext, step: string, k: Omit<CheckedSpend, "outcome">): void {
	const { facts, verdict, proven } = k
	c.report.push("checks", {
		step,
		txHash: proven.txHash.toString(),
		anchorBlock: proven.anchor.number,
		anchorTime: proven.anchor.timestamp,
		sequence: facts.record.sequence,
		l1Block: facts.l1.l1Block,
		l1BlockHash: facts.l1.l1BlockHash,
		poolRootParity: verdict.parity.poolRoot,
		rootTimeParity: verdict.parity.rootTime,
		marginSec: verdict.margin,
		failed: verdict.failed,
	})
	c.report.flush()
	report("checked", {
		step,
		anchorBlock: proven.anchor.number,
		sequence: facts.record.sequence,
		marginSec: verdict.margin,
		failed: verdict.failed.join(","),
	})
}

/** A checked spend of the holder's `label` notes, built by `build` from the label's path, required to land. */
export async function spendLabel(
	c: CanaryContext,
	h: Holder,
	step: string,
	at: { label: bigint; origin: Origin; post: BlockRef },
	build: (path: LabelPath) => Promise<ExecutionPayload>,
): Promise<void> {
	let provingMs: number | undefined
	const r = await checkedSpend(
		c.spendIo,
		{ ...at, minSequence: c.minSequence, budgetSec: PROVING_BUDGET_SEC },
		{
			prove: async (path) => h.account.prove(await build(path)),
			send: (proven) => sendProven(c, step, proven, provingMs),
			onChecked: (k) => {
				provingMs = k.provingMs
				recordChecks(c, step, k)
			},
		},
	)
	landed(r.outcome, step)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Re-reads `read` until `done` holds, at most `reads` times `pauseMs` apart: the wallet's note sync
 * trails the block that made them.
 * @throws CanaryError `errorClass` when it never holds
 */
export async function until<T>(
	read: () => Promise<T>,
	done: (v: T) => boolean,
	errorClass: string,
	what: string,
	reads = 30,
	pauseMs = 4_000,
): Promise<T> {
	for (let i = 1; ; i++) {
		const v = await read()
		if (done(v)) return v
		if (i >= reads) throw new CanaryError("FAILED", errorClass, what)
		await sleep(pauseMs)
	}
}
