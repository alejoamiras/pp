/**
 * The fixture bridge session. It keeps the rules the driver depends on (a preflight bound to its
 * recipient for 10 minutes and consumed by a send, a proof spent once and only under the attempt it
 * was made for, at most two internal re-proofs, the journal's
 * `IN_FLIGHT` and `UNCERTAIN` for an earlier attempt, the send going through the guarded wallet so
 * `handoff` runs first, a journal record written before the send and restored on a refusal), and holds
 * the signature it was opened with in its closure only.
 */
import { type Address, type Hex, isAddressEqual, type TypedDataDefinition } from "viem"
import type { AztecAddress, BridgeRecordView, PoolNoteView } from "../stack-types"
import { BridgeFailure, ProviderError, providerCode, type UiCode } from "../errors"
import { parseAztecAddress } from "../parse"
import type { Attempt, ClaimHooks, Proved, Sent, Session, SessionPort, SubmitHooks } from "../ports"
import { type Eip1193Provider, guardedProvider } from "../wallet/guarded-provider"
import { ACCOUNTS, type FixtureBridge, type FixtureNote } from "./seed"
import type { World } from "./world"

const PREFLIGHT_MS = 10 * 60_000
const MAX_REPROOFS = 2

const never = <T>() => new Promise<T>(() => {})
const fail = (code: string): never => {
	throw new BridgeFailure(code as UiCode)
}

/** A different pairing per note, so ids and nullifiers never collide. */
export const nullifierOf = (commitment: bigint): bigint => commitment * 7919n + 104_729n
const idOf = (note: bigint) => `fx-${nullifierOf(note).toString(16)}`

function typedData(owner: Address, chainId: number): TypedDataDefinition {
	return {
		domain: { name: "pp fixtures", version: "1", chainId },
		types: { Derive: [{ name: "owner", type: "address" }] },
		primaryType: "Derive",
		message: { owner },
	}
}

function stepOf(w: World, b: FixtureBridge): BridgeRecordView["step"] {
	if (b.state === "reverted") return { error: "REVERTED" }
	if (b.state === "claimed") return "claimed"
	if (b.state === "pending" || b.state === "sent") return "submitted"
	return w.aztecBlock() > b.minedAtAztecBlock ? "claimable" : "mined"
}

function view(w: World, b: FixtureBridge): BridgeRecordView {
	return {
		id: b.id,
		nullifier: b.nullifier,
		recipient: b.recipient,
		amount: b.amount,
		step: stepOf(w, b),
		...(b.l1TxHash ? { l1TxHash: b.l1TxHash } : {}),
	}
}

/** The wallet behind the guard; an armed `send` fault or hang answers here, after the guard let it through. */
function sendingWallet(inner: Eip1193Provider, fault: string | null, hang: boolean): Eip1193Provider {
	return {
		async request(args) {
			if (fault === "REJECTED") throw new ProviderError(4001, "User rejected the request.")
			if (fault === "LOST") throw new Error("the wallet's connection dropped")
			if (hang) return never()
			return inner.request(args)
		},
	}
}

interface Ctx {
	w: World
	provider: Eip1193Provider
	owner: Address
	preflights: Map<AztecAddress, number>
}

function upsertBridge(w: World, b: FixtureBridge): void {
	w.update((s) => {
		s.bridges = [...s.bridges.filter((x) => x.id !== b.id), b]
	})
}

/** Puts back the note's record as it stood before a send, or none. */
function restore(w: World, note: bigint, before: FixtureBridge | undefined): void {
	w.update((s) => {
		s.bridges = [...s.bridges.filter((b) => b.id !== idOf(note)), ...(before ? [before] : [])]
	})
}

function journalled(c: Ctx, a: Attempt, note: FixtureNote, state: FixtureBridge["state"], l1TxHash?: Hex): FixtureBridge {
	return {
		id: idOf(a.note),
		owner: c.owner,
		note: a.note,
		nullifier: nullifierOf(a.note),
		recipient: a.recipient,
		label: note.label,
		amount: a.amount,
		...(l1TxHash ? { l1TxHash } : {}),
		state,
		minedAtAztecBlock: c.w.aztecBlock(),
	}
}

function mine(c: Ctx, a: Attempt, note: FixtureNote, l1TxHash: Hex): FixtureBridge {
	const b = journalled(c, a, note, "mined", l1TxHash)
	const changeCommitment = BigInt(c.w.nextHex(31))
	c.w.update((s) => {
		s.l1Block++
		note.status = "spent"
		// The change keeps the label and its approval; a whole-note bridge leaves it at 0.
		s.notes.push({ commitment: changeCommitment, label: note.label, value: note.value - a.amount, status: "approved" })
	})
	upsertBridge(c.w, b)
	return b
}

function checkSubmit(c: Ctx, a: Attempt, o?: { acceptUncertain?: true }): void {
	const { w } = c
	if (w.s.walletChain !== a.chainId) fail("CHAIN_MISMATCH")
	if (a.deployment !== w.deployment.id) fail("DEPLOYMENT_MISMATCH")
	if (isAddressEqual(a.sender, c.owner)) fail("SENDER_IS_OWNER")
	if ((c.preflights.get(a.recipient) ?? -1) < w.timer.now()) fail("PREFLIGHT_REQUIRED")
	const fault = w.takeFault("submit")
	const note = w.s.notes.find((n) => n.commitment === a.note)
	// The journal's answer for an earlier attempt that left no hash, so the page reads it back the same way.
	if (fault === "UNCERTAIN" && note) upsertBridge(w, journalled(c, a, note, "pending"))
	if (fault !== null) fail(fault)
	const prior = w.s.bridges.find((b) => b.id === idOf(a.note))
	if (prior?.state === "sent") fail("IN_FLIGHT")
	if (prior?.state === "pending" && !o?.acceptUncertain) fail("UNCERTAIN")
}

async function reprove(w: World, on: SubmitHooks): Promise<void> {
	for (let i = 0; ; i++) {
		const stale = w.takeReprove()
		if (stale === null) return
		if (i === MAX_REPROOFS) throw new BridgeFailure("STALE", { stale })
		on.reproving(stale)
		// The re-proof yields, so a wallet change can land while it is held.
		await Promise.resolve()
	}
}

async function submit(c: Ctx, a: Attempt, on: SubmitHooks, o?: { acceptUncertain?: true }): Promise<BridgeRecordView> {
	const { w } = c
	checkSubmit(c, a, o)
	await reprove(w, on)
	if ((c.preflights.get(a.recipient) ?? -1) < w.timer.now()) fail("PREFLIGHT_REQUIRED")
	c.preflights.delete(a.recipient)
	const note = w.s.notes.find((n) => n.commitment === a.note)
	if (note?.status !== "approved" || note.value < a.amount) return fail("CONSUMED_ELSEWHERE")
	const sendFault = w.takeFault("send")
	const wallet = guardedProvider(sendingWallet(c.provider, sendFault, w.takeHang("send")), on.handoff)
	const before = w.s.bridges.find((b) => b.id === idOf(a.note))
	// Journalled before the wallet is asked, so a reload mid-send still knows a bridge may be out.
	upsertBridge(w, journalled(c, a, note, "pending"))
	let hash: Hex
	try {
		hash = (await wallet.request({ method: "eth_sendTransaction", params: [{ from: a.sender, to: w.deployment.portal }] })) as Hex
	} catch (err) {
		// A refusal before broadcast leaves the journal as it was; any other failure may have sent.
		if (providerCode(err) === 4001) restore(w, a.note, before)
		throw err
	}
	// The journal gains the hash when the wallet returns it; the receipt comes after.
	upsertBridge(w, journalled(c, a, note, "sent", hash))
	on.sent(hash)
	// bridge-core waits for the receipt, which this transaction never gets.
	if (sendFault === "PENDING") return never()
	if (sendFault === "REVERTED") {
		// A revert settles this send only: an unconfirmed earlier one may still land, so its record stays
		// the note's, and later submits still need the override until the chain shows the event.
		if (before?.state === "pending") restore(w, a.note, before)
		else upsertBridge(w, journalled(c, a, note, "reverted", hash))
		w.update((s) => void s.l1Block++)
		throw new BridgeFailure("REVERTED", { l1TxHash: hash, stale: null })
	}
	return view(w, mine(c, a, note, hash))
}

async function claim(c: Ctx, id: string, on: ClaimHooks): Promise<Sent> {
	const { w } = c
	const b = w.s.bridges.find((x) => x.id === id && x.owner === c.owner)
	if (!b || stepOf(w, b) !== "claimable") return fail("NOT_CLAIMABLE")
	const fault = w.takeFault("claim")
	await Promise.resolve()
	on.handoff()
	if (w.takeHang("claim")) return never()
	if (fault === "REJECTED") throw new ProviderError(4001, "Transaction rejected by user")
	const txHash = w.nextHex(32)
	w.update((s) => void s.sent.aztec++)
	if (fault === "DROPPED") return { txHash, status: "dropped" }
	if (fault === "REVERTED") return { txHash, status: "reverted", reason: "claim_from_pool: message already consumed" }
	w.update((s) => {
		b.state = "claimed"
		s.aztecNotes.push({ owner: b.recipient, label: b.label, origin: 0, value: b.amount })
	})
	return { txHash, status: "success" }
}

function waitClaimable(c: Ctx, id: string, signal: AbortSignal): Promise<void> {
	const { w } = c
	return new Promise<void>((resolve, reject) => {
		const b = w.s.bridges.find((x) => x.id === id && x.owner === c.owner && (x.state === "mined" || x.state === "claimed"))
		if (!b) return reject(new BridgeFailure("NOT_CLAIMABLE"))
		signal.addEventListener("abort", () => reject(signal.reason), { once: true })
		void w.until(() => stepOf(w, b) !== "mined", signal).then(resolve)
	})
}

function notes(c: Ctx): PoolNoteView[] {
	if (!isAddressEqual(c.owner, ACCOUNTS.owner)) return []
	return c.w.s.notes.map((n) => ({ ...n, asset: "0x00000000000000000000000000000000000a55e7" }))
}

function makeSession(c: Ctx, signature: Hex): Session {
	const { w } = c
	// The only copy of the signature; nothing reads it back out.
	let held: Hex | null = signature
	let cancel: ((e: Error) => void) | null = null
	const live = () => {
		if (held === null) fail("FORGED_SESSION")
	}
	// Each proof answers for the attempt it was made under, once.
	const proofs = new WeakMap<Proved, Attempt>()
	return {
		owner: c.owner,
		async notes() {
			live()
			return notes(c)
		},
		async nullifierOf(commitment) {
			live()
			return nullifierOf(commitment)
		},
		async preflight(recipient) {
			live()
			if (w.takeHang("preflight")) await never()
			const fault = w.takeFault("preflight")
			if (fault !== null) fail(fault)
			if (parseAztecAddress(recipient) === null) fail("RECIPIENT_INVALID")
			c.preflights.set(recipient, w.timer.now() + PREFLIGHT_MS)
		},
		warmUp: async () => live(),
		async prove(a) {
			live()
			if (w.takeHang("prove"))
				return new Promise<Proved>((_, reject) => {
					cancel = reject
				})
			const fault = w.takeFault("prove")
			if (fault !== null) fail(fault)
			const note = w.s.notes.find((n) => n.commitment === a.note && n.status === "approved" && n.value >= a.amount)
			if (!note) return fail("NOTE_NOT_FOUND")
			const proved = { note: a.note, label: note.label, amount: a.amount, change: note.value - a.amount } as Proved
			proofs.set(proved, a)
			return proved
		},
		cancelProve() {
			cancel?.(new BridgeFailure("RPC_FAILED"))
			cancel = null
		},
		async submit(p, a, on, o) {
			live()
			const bound = proofs.get(p)
			proofs.delete(p)
			if (bound !== a) fail("SPEND_MISMATCH")
			return submit(c, a, on, o)
		},
		waitClaimable: (id, signal) => waitClaimable(c, id, signal),
		async claim(id, on) {
			live()
			return claim(c, id, on)
		},
		async records() {
			live()
			return w.s.bridges.filter((b) => b.owner === c.owner && !b.forgotten).map((b) => view(w, b))
		},
		async recover(recipient) {
			live()
			return w.s.bridges.filter((b) => b.owner === c.owner && b.recipient === recipient && b.state === "mined").map((b) => view(w, b))
		},
		async l1TxState(hash) {
			live()
			const b = w.s.bridges.find((x) => x.l1TxHash === hash)
			if (b === undefined) return "unknown"
			return b.state === "sent" ? "pending" : b.state === "reverted" ? "reverted" : "mined"
		},
		close() {
			held = null
		},
	}
}

export function fixtureSessions(w: World, provider: Eip1193Provider): SessionPort {
	return {
		async open({ owner, sign }) {
			const fault = w.takeFault("open")
			if (fault !== null) fail(fault)
			const signature = await sign(typedData(owner, w.s.chainId))
			if (!/^0x[0-9a-fA-F]{128,130}$/.test(signature)) fail("FORGED_SESSION")
			return makeSession({ w, provider, owner, preflights: new Map() }, signature)
		},
		async forget() {
			// Only a mined bridge is on chain for `recover`; every other record lived in this journal alone.
			w.update((s) => {
				s.bridges = s.bridges.filter((b) => b.state !== "pending" && b.state !== "sent").map((b) => ({ ...b, forgotten: true }))
			})
		},
	}
}
