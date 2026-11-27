/**
 * The fixture token and hub on Aztec. The views page by `start` and their answers go through the same
 * parsers a wallet's would; the sends apply the contracts' rules the screens depend on: a checked spend
 * needs an ACTIVE label, a spend takes at most 8 notes, a ragequit only an exact chunk.
 */
import type { Address } from "viem"
import type { AztecAddress, Origin } from "../stack-types"
import { assertSpendable, MAX_NOTES_PER_BURN, ragequitChunks } from "../chunks"
import { BridgeFailure, ProviderError } from "../errors"
import { BALANCES_PAGE, NOTES_PAGE, readAllPages } from "../paging"
import { BN254_P, isAztecPoint, parseBalanceRow, parsePayee, parseU128 } from "../parse"
import type { AztecPort, AztecReceipt, LabelBalance, ReceiptPort, Sent } from "../ports"
import { fixtureLabelState } from "./allow-list"
import type { FixtureOp } from "./faults"
import type { AztecNote } from "./seed"
import type { World } from "./world"

const desc = (a: AztecNote, b: AztecNote) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0)
const ofLabel = (w: World, owner: AztecAddress, label: bigint) => w.s.aztecNotes.filter((n) => n.owner === owner && n.label === label)
/** As the wallet lists them: every origin under the label, as the stack port reads them before a spend. */
const noteValues = (w: World, owner: AztecAddress, label: bigint) => ofLabel(w, owner, label).map((n) => n.value)

/** `private_balances_by_label(owner, start)`: raw `(label, origin, balance)` triples, as a wallet answers. */
function balancesView(w: World, owner: AztecAddress, start: number): unknown[][] {
	const totals = new Map<string, [bigint, number, bigint]>()
	for (const n of w.s.aztecNotes) {
		if (n.owner !== owner) continue
		const key = `${n.label}:${n.origin}`
		const t = totals.get(key) ?? [n.label, n.origin, 0n]
		t[2] += n.value
		totals.set(key, t)
	}
	return [...totals.values()].slice(start, start + BALANCES_PAGE)
}

/** `private_notes_by_label(owner, label, start)`: note values, largest first. */
function notesView(w: World, owner: AztecAddress, label: bigint, start: number): unknown[] {
	return ofLabel(w, owner, label)
		.sort(desc)
		.map((n) => n.value)
		.slice(start, start + NOTES_PAGE)
}

/** Each world's included sends by hash, as its node would answer for them; a dropped one is never included. */
const included = new WeakMap<World, Map<string, AztecReceipt>>()

function record(w: World, sent: Sent): Sent {
	const m = included.get(w) ?? new Map<string, AztecReceipt>()
	included.set(w, m)
	if (sent.txHash && sent.status === "success") m.set(sent.txHash, { status: "success" })
	if (sent.txHash && sent.status === "reverted") m.set(sent.txHash, { status: "reverted", block: sent.block })
	return sent
}

/** One wallet send: an armed fault answers like the wallet or the chain would; `effect` returns a revert reason or applies. */
function send(w: World, op: FixtureOp, effect: () => string | null): Sent {
	const fault = w.takeFault(op)
	if (fault === "REJECTED") throw new ProviderError(4001, "Transaction rejected by user")
	const txHash = w.nextHex(32)
	w.update((s) => void s.sent.aztec++)
	if (fault === "DROPPED") return { txHash, status: "dropped" }
	if (fault === "UNCONFIRMED") return { txHash, status: "unconfirmed" }
	if (fault === "REVERTED") return record(w, { txHash, status: "reverted", block: w.aztecBlock(), reason: `${op}: reverted` })
	const reason = effect()
	return record(w, reason === null ? { txHash, status: "success" } : { txHash, status: "reverted", block: w.aztecBlock(), reason })
}

/** The node's read of a send this world made; any other hash is not included. */
export function fixtureReceipts(w: World): ReceiptPort {
	return { aztec: async (txHash) => included.get(w)?.get(txHash) ?? { status: "pending" } }
}

/** Takes the largest notes of one label and origin until `amount`, at most 8; returns the change or a revert reason. */
function spend(w: World, owner: AztecAddress, label: bigint, origin: Origin, amount: bigint): bigint | string {
	const picked = ofLabel(w, owner, label)
		.filter((n) => n.origin === origin)
		.sort(desc)
		.slice(0, MAX_NOTES_PER_BURN)
	let sum = 0n
	let used = 0
	for (const n of picked) {
		if (sum >= amount) break
		sum += n.value
		used++
	}
	if (sum < amount) return "balance too low within 8 notes"
	const gone = new Set(picked.slice(0, used))
	w.update((s) => {
		s.aztecNotes = s.aztecNotes.filter((n) => !gone.has(n))
	})
	return sum - amount
}

function checkedSpend(w: World, from: AztecAddress, label: bigint, origin: Origin, amount: bigint, credit: (change: bigint) => void) {
	return () => {
		const state = fixtureLabelState(w, label, origin)
		if (state !== "ACTIVE") return `label check failed: ${state}`
		const change = spend(w, from, label, origin, amount)
		if (typeof change === "string") return change
		w.update((s) => {
			if (change > 0n) s.aztecNotes.push({ owner: from, label, origin, value: change })
			credit(change)
		})
		return null
	}
}

function publicOf(w: World, owner: AztecAddress): bigint {
	return w.s.publicBalances.find((b) => b.owner === owner)?.amount ?? 0n
}

function addPublic(w: World, owner: AztecAddress, delta: bigint): void {
	w.update((s) => {
		const row = s.publicBalances.find((b) => b.owner === owner)
		if (row) row.amount += delta
		else s.publicBalances.push({ owner, amount: delta })
	})
}

function addExit(w: World, a: { kind: "ragequit" | "public"; payee: Address; amount: bigint; label: bigint }): void {
	const l2TxHash = w.nextHex(32)
	w.update((s) => {
		s.exits.push({ deployment: w.deployment.id, l2TxHash, messageIndexInTx: 0, ...a, readyAtAztecBlock: w.aztecBlock() + 2 })
	})
}

function checkPayee(w: World, payee: Address): void {
	if (!parsePayee(payee, w.deployment.portal).ok) throw new BridgeFailure("PAYEE_INVALID")
}

export function fixtureAztec(w: World): AztecPort {
	return {
		async balancesByLabel(owner) {
			const rows = await readAllPages(async (start) => balancesView(w, owner, start), BALANCES_PAGE)
			return rows.map(parseBalanceRow).filter((b): b is LabelBalance => b !== null)
		},
		async notesByLabel(owner, label) {
			const values = await readAllPages(async (start) => notesView(w, owner, label, start), NOTES_PAGE)
			return values.map(parseU128).filter((v): v is bigint => v !== null)
		},
		publicBalance: async (owner) => publicOf(w, owner),
		async transferPrivate(from, { to, amount, label, origin }, on) {
			// The wallet refuses an address that cannot receive notes before it proves anything.
			if (!isAztecPoint(to)) throw new BridgeFailure("RECIPIENT_INVALID")
			assertSpendable(noteValues(w, from, label), amount)
			on.handoff()
			return send(
				w,
				"transferPrivate",
				checkedSpend(w, from, label, origin, amount, () => w.s.aztecNotes.push({ owner: to, label, origin, value: amount })),
			)
		},
		async unshield(from, { amount, label, origin }, on) {
			assertSpendable(noteValues(w, from, label), amount)
			on.handoff()
			return send(
				w,
				"unshield",
				checkedSpend(w, from, label, origin, amount, () => addPublic(w, from, amount)),
			)
		},
		async shield(from, amount) {
			return send(w, "shield", () => {
				if (publicOf(w, from) < amount) return "public balance too low"
				const label = BigInt(w.nextHex(31)) % BN254_P
				addPublic(w, from, -amount)
				w.update((s) => {
					s.aztecNotes.push({ owner: from, label, origin: 1, value: amount })
					s.allowList.pendingBirths.push(label)
				})
				return null
			})
		},
		async ragequit(from, { payee, label, amount }, on) {
			checkPayee(w, payee)
			const values = ofLabel(w, from, label).map((n) => n.value)
			if (ragequitChunks(values, amount).length !== 1) throw new BridgeFailure("NO_EXACT_CHUNKS")
			on.handoff()
			return send(w, "ragequit", () => {
				const origin = ofLabel(w, from, label)[0]?.origin ?? 0
				const change = spend(w, from, label, origin, amount)
				if (typeof change === "string") return change
				addExit(w, { kind: "ragequit", payee, amount, label })
				return null
			})
		},
		async exitPublic(from, { payee, amount }) {
			checkPayee(w, payee)
			return send(w, "exitPublic", () => {
				if (publicOf(w, from) < amount) return "public balance too low"
				addPublic(w, from, -amount)
				addExit(w, { kind: "public", payee, amount, label: 0n })
				return null
			})
		},
	}
}
