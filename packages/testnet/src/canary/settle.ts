import { type ExitTicket, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { report } from "../cli/common"
import { CanaryError } from "../report"
import type { ExitContext } from "./context"
import { EPOCH_PROOF_POLL_MS, exitIo, settleEach, ticketsOf, waitEpochProof } from "./exits"

/** Ticket reads after the burns before a burn without its ticket counts as a failure; the node indexes logs after the receipt. */
const TICKET_READS = 15
const TICKET_PAUSE_MS = 4_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Each of the context's burns' tickets, once every burn shows one. Reads from the first burn's block
 * when every burn's block is known.
 * @throws CanaryError `TICKET_NOT_FOUND` naming the burns still without one after `TICKET_READS` reads
 */
export async function burnTickets(c: ExitContext, reads = TICKET_READS): Promise<ExitTicket[]> {
	const blocks = c.burns.map((b) => b.block)
	const fromBlock = blocks.every((b) => b !== undefined) ? BigInt(Math.min(...(blocks as number[]))) : undefined
	for (let i = 1; ; i++) {
		const all = await c.client.exitTickets({ payee: c.payee, ...(fromBlock === undefined ? {} : { fromBlock }) })
		const { found, missing } = ticketsOf(c.burns, all, c.payee)
		if (!missing.length) return found
		if (i >= reads)
			throw new CanaryError("FAILED", "TICKET_NOT_FOUND", `no ragequit ticket to ${c.payee} from L2 tx ${missing.join(", ")}`)
		await sleep(TICKET_PAUSE_MS)
	}
}

/**
 * Waits for an Outbox root to cover every ticket, within one shared budget, then settles each and checks
 * what the portal paid. Each settled burn enters the report as it settles.
 */
export async function epochThenSettle(c: ExitContext, tickets: readonly ExitTicket[]): Promise<void> {
	await c.report.step("epochProof", async () => {
		const t0 = performance.now()
		const deadline = Date.now() + c.epochProofBudgetMs
		const io = exitIo(c.node, c.client)
		for (const t of tickets) await waitEpochProof(io, t, { deadline, pollMs: EPOCH_PROOF_POLL_MS, log: c.log })
		c.report.wait("epochProof", performance.now() - t0)
	})
	const io = {
		settle: (t: ExitTicket) => c.client.settle(t, c.sender),
		logs: async (hash: `0x${string}`) =>
			(await c.l1.waitForTransactionReceipt({ hash, timeout: PUBLIC_CHAIN_TIMING.receiptTimeoutMs })).logs,
	}
	await c.report.step("settle", () =>
		settleEach(io, c.d.bridge.portal, tickets, (t, l1TxHash) => {
			c.settled.add(t.l2TxHash.toLowerCase())
			c.report.push("settles", { l2TxHash: t.l2TxHash, l1TxHash, amount: t.amount })
			c.report.flush()
			report("settled", { l2TxHash: t.l2TxHash, l1TxHash, amount: t.amount })
		}),
	)
}

/** `canary --settle`: the listed burns' tickets to the canary owner, settled once an Outbox root covers each. */
export async function settleListed(c: ExitContext): Promise<void> {
	const { found, missing } = ticketsOf(c.burns, await c.client.exitTickets({ payee: c.payee }), c.payee)
	if (missing.length)
		throw new CanaryError("FAILED", "TICKET_NOT_FOUND", `no ragequit ticket to ${c.payee} from L2 tx ${missing.join(", ")}`)
	await epochThenSettle(c, found)
}
