/**
 * The canary's exits after its burns: each burn's ticket, the wait for an Outbox root to cover it, the
 * settle and the check of what the portal paid. `canary --settle` runs the same path from burn hashes.
 */
import { TxHash } from "@aztec-labs/stdlib/tx"
import { type BridgeClient, type ExitStatus, type ExitTicket, PROCESSOR_PORTAL_ABI } from "@pp/bridge-core"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { type Address, type Hash, type Hex, isAddressEqual, type Log, parseEventLogs } from "viem"
import { CanaryError } from "../report"

export const EPOCH_PROOF_BUDGET_MS = 75 * 60_000
export const EPOCH_PROOF_POLL_MS = 15_000
/** Consecutive failed polls the wait absorbs; the next one ends it. */
export const MAX_FAULTS = 5

/** What one poll saw: the ticket's status, its burn's effect gone from the node, or a read that threw. */
export type Observation = ExitStatus | "missing-effect" | "fault"

export type PollState = { deadline: number; faults: number }

export type PollVerdict = "poll" | "ready" | "settled" | "timeout" | "faults"

/**
 * One poll's decision. Only a `proving` read counts as waiting: a fault or a missing effect never ends
 * the wait as a time-out, and more than `MAX_FAULTS` of them in a row end it as a failure.
 */
export function nextPoll(s: PollState, o: Observation, now: number): { state: PollState; verdict: PollVerdict } {
	if (o === "ready" || o === "settled") return { state: { ...s, faults: 0 }, verdict: o }
	if (o === "proving") return { state: { ...s, faults: 0 }, verdict: now >= s.deadline ? "timeout" : "poll" }
	const faults = s.faults + 1
	return { state: { ...s, faults }, verdict: faults > MAX_FAULTS ? "faults" : "poll" }
}

/** The two reads a poll makes, apart: the burn's effect on the node, and the ticket's exit status. */
export type ExitIo = {
	/** Whether the node still serves the burn's effect with the ticket's message in it. */
	effect(t: ExitTicket): Promise<boolean>
	status(t: ExitTicket): Promise<ExitStatus>
}

export function exitIo(node: Pick<AztecNode, "getTxReceipt">, client: Pick<BridgeClient, "exitStatus">): ExitIo {
	return {
		async effect(t) {
			const r = await node.getTxReceipt(TxHash.fromString(t.l2TxHash), { includeTxEffect: true })
			return (r.txEffect?.l2ToL1Msgs.length ?? 0) > t.messageIndexInTx
		},
		status: (t) => client.exitStatus(t),
	}
}

async function observe(io: ExitIo, t: ExitTicket): Promise<Observation> {
	try {
		if (!(await io.effect(t))) return "missing-effect"
		return await io.status(t)
	} catch {
		return "fault"
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Polls every `pollMs` until an Outbox root covers `t` (or it is already settled), logged as
 * "waiting for the epoch proof".
 * @throws CanaryError `EPOCH_PROOF_TIMEOUT` past `deadline`; `RPC_EVIDENCE_MISSING` or `READ_FAULT`
 * after more than `MAX_FAULTS` failed polls in a row
 */
export async function waitEpochProof(
	io: ExitIo,
	t: ExitTicket,
	o: { deadline: number; pollMs: number; log(line: string): void },
): Promise<"ready" | "settled"> {
	o.log(`waiting for the epoch proof of L2 tx ${t.l2TxHash} until ${new Date(o.deadline).toISOString()}`)
	let state: PollState = { deadline: o.deadline, faults: 0 }
	for (;;) {
		const seen = await observe(io, t)
		const next = nextPoll(state, seen, Date.now())
		state = next.state
		if (next.verdict === "ready" || next.verdict === "settled") return next.verdict
		if (next.verdict === "timeout")
			throw new CanaryError("EPOCH_PROOF_TIMEOUT", "EPOCH_PROOF_TIMEOUT", `no Outbox root covered L2 tx ${t.l2TxHash} in time`)
		const errorClass = seen === "missing-effect" ? "RPC_EVIDENCE_MISSING" : "READ_FAULT"
		if (next.verdict === "faults")
			throw new CanaryError("FAILED", errorClass, `${MAX_FAULTS + 1} failed polls in a row for L2 tx ${t.l2TxHash}`)
		if (seen !== "proving") o.log(`${errorClass} polling L2 tx ${t.l2TxHash} (${state.faults} of ${MAX_FAULTS} absorbed)`)
		await sleep(o.pollMs)
	}
}

/** A burn the canary sent, or a hash `--settle` was given; `amount` and `label` are known only for the former. */
export type Burn = { txHash: Hex; amount?: bigint; label?: bigint; block?: number }

/**
 * Each burn's ticket: the ragequit ticket its transaction made to `payee`. A burn without one yet is
 * `missing`; one with several, or with another amount or label than it burned, is not the canary's.
 * @throws CanaryError `RPC_INCONSISTENT`
 */
export function ticketsOf(burns: readonly Burn[], tickets: readonly ExitTicket[], payee: Address): { found: ExitTicket[]; missing: Hex[] } {
	const found: ExitTicket[] = []
	const missing: Hex[] = []
	for (const b of burns) {
		const mine = tickets.filter(
			(t) => BigInt(t.l2TxHash) === BigInt(b.txHash) && t.kind === "ragequit" && isAddressEqual(t.payee, payee),
		)
		const [t, ...more] = mine
		if (!t) {
			missing.push(b.txHash)
			continue
		}
		const exact = t.kind === "ragequit" && (b.amount ?? t.amount) === t.amount && (b.label ?? t.label) === t.label
		if (more.length || !exact)
			throw new CanaryError("FAILED", "RPC_INCONSISTENT", `L2 tx ${b.txHash} shows another ticket than its burn`)
		found.push(t)
	}
	return { found, missing }
}

/** Whether `logs` hold the portal's `ExitSettled` paying `t`: its payee, amount and label (0 for a public exit). */
export function paysTicket(logs: readonly Log[], portal: Address, t: ExitTicket): boolean {
	const label = t.kind === "ragequit" ? t.label : 0n
	return parseEventLogs({ abi: PROCESSOR_PORTAL_ABI, eventName: "ExitSettled", logs: [...logs] }).some(
		(e) =>
			isAddressEqual(e.address, portal) &&
			isAddressEqual(e.args.payee, t.payee) &&
			e.args.amount === t.amount &&
			e.args.label === label,
	)
}

export type SettleIo = {
	settle(t: ExitTicket): Promise<Hash>
	logs(tx: Hash): Promise<readonly Log[]>
}

/**
 * Settles each ticket, or takes the transaction that already did, and requires its `ExitSettled` to pay
 * the ticket whoever sent it.
 * @throws CanaryError `SETTLED_EVENT` when the settling transaction carries no such event
 */
export async function settleEach(
	io: SettleIo,
	portal: Address,
	tickets: readonly ExitTicket[],
	onSettled: (t: ExitTicket, l1TxHash: Hash) => void,
): Promise<void> {
	for (const t of tickets) {
		const l1TxHash = await io.settle(t)
		if (!paysTicket(await io.logs(l1TxHash), portal, t))
			throw new CanaryError("FAILED", "SETTLED_EVENT", `L1 tx ${l1TxHash} carries no ExitSettled for L2 tx ${t.l2TxHash}`)
		onSettled(t, l1TxHash)
	}
}
