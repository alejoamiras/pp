import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import * as fc from "fast-check"
import {
	ContractFunctionRevertedError,
	type Hash,
	type Hex,
	hexToBigInt,
	keccak256,
	toHex,
	UserRejectedRequestError,
	type WalletClient,
} from "viem"
import { beforeAll, describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import {
	aztecWallet,
	bridgeSpend,
	context,
	DEPLOYMENT,
	FakeChain,
	fakePool,
	memoryStore,
	NETWORK,
	NULLIFIER,
	openSession,
} from "../test/client-fakes"
import { MAX_UNRESOLVED_ATTEMPTS } from "./attempts"
import { BridgeClientError } from "./errors"
import { Journal, type JournalRecord, type KeyValueStore, STORAGE_PREFIX, sealRecord } from "./journal"
import { bridgeMessageKey } from "./messages"
import { Preflights } from "./preflight"
import { type BridgeSession, useSession } from "./session"
import { type SubmitContext, submit } from "./submit"
import type { BridgeReceipt, PreparedBridgeSpend } from "./types"

// The model keeps what the chain and the store really hold; the code under test sees only the store and RPC reads.
// Each check names the rule it enforces:
//   I1  the wallet is called exactly when no earlier send can still land, or the override admits one for the same intent;
//   I2  the store holds the record before every wallet call, and afterwards exactly the attempts the model retained;
//   I3  after UNCERTAIN, a plain submit never reaches the wallet until the chain settles that send;
//   I4  every result names what the chain shows: a receipt only for this intent's own bridge.

type Who = "A" | "B"
type Party = { recipient: AztecAddress; spend: PreparedBridgeSpend; messageKey: Hex }
const parties = {} as Record<Who, Party>
const AMOUNT = 70n
const OTHER_TX = keccak256(toHex("another bridge of the note"))

type Status = "mempool" | "dropped" | "reverted" | "landed" | "landedNoLog"
type Signals = readonly (readonly bigint[])[]
/**
 * One wallet call that may have reached the chain: it returned a hash, or failed with anything but 4001.
 * `secretHash` and `signals` are what the wallet was handed, so a landing pays what was really sent.
 */
type Broadcast = { hash: Hash; who: Who; saved: boolean; status: Status; secretHash: Hex; signals: Signals }
type Kept = { kind: "kept"; who: Who; entries: Broadcast[]; evicted: boolean }
type Stored = { kind: "none" } | { kind: "corrupt"; bytes: string } | Kept
type Model = { sent: Broadcast[]; record: Stored; spent: boolean; logs: boolean; uncertain: boolean }

type Send = "pending" | "land" | "landNoLog" | "revert" | "other"
type Fault = "none" | "reject" | "ambiguous" | "hashWrite" | "read"
type Spec = { override: boolean; who: Who; send: Send; fault: Fault }
type Result = { code: string; hash?: Hash; receipt?: BridgeReceipt }

type Hold = { reached: Promise<void>; take(): Promise<void>; release(): void }

function hold(): Hold {
	const reached = Promise.withResolvers<void>()
	const released = Promise.withResolvers<void>()
	let used = false
	return {
		reached: reached.promise,
		release: () => released.resolve(),
		take: async () => {
			if (used) return
			used = true
			reached.resolve()
			await released.promise
		},
	}
}

/** The fake chain and store one run drives, with its one-shot faults. */
class World {
	readonly chain = new FakeChain()
	readonly memory = memoryStore()
	/** submit turns whatever the wallet throws into a result, so wallet-side checks record here instead. */
	readonly violations: string[] = []
	readonly aztec = aztecWallet([parties.A.recipient, parties.B.recipient])
	steps = 0
	/** A reload since the record was last written, so the code reads it with nothing in memory. */
	reloaded = false
	failNextWrite = false
	readFault = false
	held: Hold | undefined
	session!: BridgeSession
	journal!: Journal
	preflights!: Preflights
	ctx!: SubmitContext
	key!: string
	readonly store: KeyValueStore = {
		getItem: (k) => this.memory.store.getItem(k),
		setItem: (k, v) => {
			if (this.failNextWrite) {
				this.failNextWrite = false
				throw new Error("quota")
			}
			this.memory.store.setItem(k, v)
		},
		removeItem: (k) => this.memory.store.removeItem(k),
	}

	constructor(readonly seen: Set<string>) {
		this.chain.onSend = () => {}
		const getLogs = this.chain.reader.getLogs
		Object.assign(this.chain.reader, {
			getLogs: ((q: Parameters<typeof getLogs>[0]) =>
				this.readFault ? Promise.reject(new Error("rpc down")) : getLogs(q)) as typeof getLogs,
		})
		// The vault refuses a spent nullifier, so a simulation reverts once anything consumed it.
		this.chain.simulate.mockImplementation(async () => {
			await this.held?.take()
			if (this.chain.spentAt !== 0n)
				throw new ContractFunctionRevertedError({ abi: PROCESSOR_PORTAL_ABI, functionName: "bridgeFromPool" })
			return {}
		})
	}

	/** A fresh session and preflight cache over the same store and chain, as after a page reload. */
	async reload(): Promise<void> {
		this.session = await openSession(fakePool())
		this.preflights = new Preflights()
		this.ctx = context(this.chain, this.store, this.preflights)
		this.journal = new Journal(this.store, useSession(this.session, DEPLOYMENT.id).secrets.journal, DEPLOYMENT.id)
		this.key = STORAGE_PREFIX + (await this.journal.id(NULLIFIER))
	}

	fail(rule: string, m: Model, what: string): void {
		this.violations.push(`${rule}: ${what} (model: ${showModel(m)})`)
	}
}

const showModel = (m: Model) =>
	JSON.stringify({
		...m,
		sent: m.sent.map((b, i) => `#${i} ${b.who} ${b.status}${b.saved ? "" : " hashless"}`),
		record: showStored(m.record),
	})

function showStored(s: Stored): unknown {
	if (s.kind !== "kept") return s.kind
	return { who: s.who, entries: s.entries.length, evicted: s.evicted }
}

const retained = (m: Model): Broadcast[] => (m.record.kind === "kept" ? m.record.entries : [])
const unresolved = (entries: Broadcast[]) => entries.filter((b) => !(b.saved && b.status === "reverted"))
/** May still land, as far as anyone can tell: a send the code cannot see revert is never resolved for it. */
const mayLand = (b: Broadcast) => b.status === "mempool" || b.status === "dropped" || (b.status === "reverted" && !b.saved)

const mayStillLand = (m: Model) => m.record.kind !== "kept" || m.record.evicted || m.sent.some(mayLand)

function mayCall(m: Model, s: Spec): boolean {
	if (m.spent) return false
	const rec = m.record
	if (rec.kind === "none") return true
	if (!mayStillLand(m)) return true
	if (!s.override) return false
	// A corrupt record reads as an evicted record of the caller's own intent.
	const sameIntent = rec.kind === "corrupt" || rec.who === s.who
	return sameIntent && !retained(m).some((b) => b.saved && b.status === "mempool")
}

type Plan = { who: Who; entries: Broadcast[]; evicted: boolean; kind: string }

/** The record a send writes before its wallet call, less its own new attempt. */
function planned(m: Model, who: Who): Plan {
	const rec = m.record
	if (rec.kind === "none") return { who, entries: [], evicted: false, kind: "first send" }
	const held: Omit<Kept, "kind"> = rec.kind === "corrupt" ? { who, entries: [], evicted: true } : rec
	const open = unresolved(held.entries)
	if (open.length === 0 && !held.evicted) return { who, entries: [], evicted: false, kind: "fresh send over a resolved record" }
	const evict = open.length >= MAX_UNRESOLVED_ATTEMPTS
	const entries = evict ? open.slice(open.length - MAX_UNRESOLVED_ATTEMPTS + 1) : open
	let kind = evict ? "evicting override" : "override"
	if (rec.kind === "corrupt") kind = "override over a corrupt record"
	return { who: held.who, entries, evicted: evict || held.evicted, kind }
}

function recordOf(who: Who, attempts: JournalRecord["attempts"], evicted: boolean): JournalRecord {
	const recipient = parties[who].recipient.toString().toLowerCase()
	return { nullifier: NULLIFIER, recipient, amount: AMOUNT, attempts, ...(evicted ? { evicted: true as const } : {}) }
}

const attemptOf = (b: Broadcast) => (b.saved ? { l1TxHash: b.hash } : {})
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))

async function landOn(m: Model, w: World, b: Broadcast, withLog: boolean): Promise<void> {
	if (withLog) await w.chain.land(b.secretHash, b.hash, b.signals)
	else {
		w.chain.head += 1n
		w.chain.receipts.set(b.hash, { status: "success", blockNumber: w.chain.head, transactionHash: b.hash })
	}
	w.chain.pending.delete(b.hash)
	w.chain.spentAt = w.chain.head
	b.status = withLog ? "landed" : "landedNoLog"
	m.spent = true
	m.logs ||= withLog
}

function revertOn(w: World, b: Broadcast): void {
	w.chain.pending.delete(b.hash)
	w.chain.revert(b.hash)
	b.status = "reverted"
}

/** Another bridge of the note with the same recipient's secret hash and a smaller amount. */
async function landOther(m: Model, w: World, who: Who): Promise<void> {
	const signals = parties[who].spend.proof.pubSignals.map((row, i) => (i === 5 ? [AMOUNT - 10n] : row))
	await w.chain.land(parties[who].spend.secretHash, OTHER_TX, signals)
	w.chain.spentAt = w.chain.head
	m.spent = true
	m.logs = true
}

async function settleSend(m: Model, w: World, b: Broadcast, send: Send): Promise<void> {
	if (send === "land" || send === "landNoLog") return landOn(m, w, b, send === "land")
	if (send === "other") await landOther(m, w, b.who)
	if (send === "other" || send === "revert") revertOn(w, b)
}

type Call = { n: number; sent?: Broadcast }

async function heldBeforeCall(m: Model, w: World, plan: Plan): Promise<void> {
	const { record } = await w.journal.read(NULLIFIER)
	const want = recordOf(plan.who, [...plan.entries.map(attemptOf), {}], plan.evicted)
	if (show(record) !== show(want)) w.fail("I2", m, `inside the wallet call the store held ${show(record)}, not ${show(want)}`)
}

function walletFor(m: Model, w: World, s: Spec, call: Call, may: boolean, plainAfterUncertain: boolean): WalletClient {
	const writeContract = async (args: Parameters<FakeChain["writeContract"]>[0]): Promise<Hash> => {
		call.n++
		if (!may) w.fail("I1", m, `the wallet was called for ${show(s)}`)
		if (plainAfterUncertain) w.fail("I3", m, "a plain submit after UNCERTAIN reached the wallet")
		if (w.violations.length) throw new Error("stopped by a violation")
		const plan = planned(m, s.who)
		await heldBeforeCall(m, w, plan)
		if (s.fault === "reject") throw new UserRejectedRequestError(new Error("rejected"))
		const hash = await w.chain.writeContract(args)
		const saved = s.fault !== "ambiguous" && s.fault !== "hashWrite"
		const b: Broadcast = { hash, who: s.who, saved, status: "mempool", secretHash: args.args[2], signals: args.args[0].pubSignals }
		m.sent.push(b)
		const pastHashless = plan.entries.some((e) => !e.saved && e.status === "mempool")
		m.record = { kind: "kept", who: plan.who, entries: [...plan.entries, b], evicted: plan.evicted }
		w.reloaded = false
		call.sent = b
		w.seen.add(`send: ${plan.kind}`)
		if (pastHashless) w.seen.add("send: past a hashless pending send")
		await settleSend(m, w, b, s.send)
		if (s.fault === "ambiguous") throw new Error("connection reset")
		if (s.fault === "hashWrite") w.failNextWrite = true
		return hash
	}
	return Object.assign(w.chain.wallet(), { writeContract }) as unknown as WalletClient
}

async function settle(p: Promise<BridgeReceipt>): Promise<Result> {
	try {
		const receipt = await p
		return { code: "RECEIPT", hash: receipt.l1TxHash, receipt }
	} catch (e) {
		if (!(e instanceof BridgeClientError)) throw e
		return { code: e.code, hash: e.l1TxHash }
	}
}

const AFTER_SEND: Record<Send, string> = {
	pending: "UNCERTAIN",
	land: "RECEIPT",
	landNoLog: "RPC_INCONSISTENT",
	revert: "REVERTED",
	other: "CONSUMED_ELSEWHERE",
}

/** I4 once a send went out: what landed decides, and a failed save or read of the outcome is UNCERTAIN. */
function afterSend(s: Spec, b: Broadcast): Result {
	const hash = s.fault === "ambiguous" ? undefined : b.hash
	if (s.fault === "read") return { code: "UNCERTAIN", hash }
	if (s.send === "land") return { code: "RECEIPT", hash: b.hash }
	if (s.fault !== "none") return { code: "UNCERTAIN", hash }
	return { code: AFTER_SEND[s.send], hash }
}

/** I4 when nothing was sent: an event for the note decides; otherwise the refusal names the last unresolved hash. */
function heldBack(m: Model, s: Spec): Result {
	const mined = retained(m).find((b) => b.saved && (b.status === "landed" || b.status === "landedNoLog"))
	const own = m.sent.find((b) => b.status === "landed" && b.who === s.who)
	if (s.fault === "read") return mined ? { code: "UNCERTAIN", hash: mined.hash } : { code: "RPC_FAILED" }
	if (own) return { code: "RECEIPT", hash: own.hash }
	if (mined && !m.logs) return { code: "RPC_INCONSISTENT", hash: mined.hash }
	if (m.spent) return { code: "CONSUMED_ELSEWHERE", hash: mined?.hash }
	const open = m.record.kind === "kept" ? unresolved(m.record.entries) : []
	const pending = open.some((b) => b.saved && b.status === "mempool")
	return { code: pending ? "IN_FLIGHT" : "UNCERTAIN", hash: open.filter((b) => b.saved).at(-1)?.hash }
}

function expectBridge(m: Model, w: World, who: Who, r: BridgeReceipt): void {
	const landed = m.sent.filter((b) => b.status === "landed" && b.who === who).map((b) => b.hash)
	expect(landed, "I4: a receipt names this intent's own landed bridge").toContain(r.l1TxHash)
	expect(r.amount, "I4: the receipt's amount").toBe(AMOUNT)
	expect(r.nullifier, "I4: the receipt's nullifier").toBe(NULLIFIER)
	expect(r.messageKey.toLowerCase(), "I4: the receipt's message key").toBe(parties[who].messageKey.toLowerCase())
	if (!retained(m).some((b) => b.hash === r.l1TxHash)) w.seen.add("receipt for a send the record no longer lists")
}

function heldBackState(m: Model, w: World, s: Spec, code: string): string[] {
	const tags: string[] = []
	if (s.override && m.record.kind === "kept" && m.record.who !== s.who) tags.push("override for another intent")
	if (m.record.kind === "corrupt") tags.push("over a record that does not open")
	if (w.reloaded && retained(m).some((b) => !b.saved)) tags.push("after a reload, over a hashless attempt")
	if (code === "CONSUMED_ELSEWHERE") tags.push(m.logs ? "another bridge's event" : "spent without an event")
	return tags
}

function transition(m: Model, w: World, s: Spec, sent: boolean, code: string): string {
	const tags = [...(s.fault === "none" ? [] : [`after ${s.fault}`]), ...(sent ? [] : heldBackState(m, w, s, code))]
	return `${sent ? `sent ${s.send}` : "held back"}: ${code}${tags.length ? ` (${tags.join(", ")})` : ""}`
}

const I3_RESULTS = new Set(["UNCERTAIN", "IN_FLIGHT", "RECEIPT", "CONSUMED_ELSEWHERE", "RPC_INCONSISTENT"])

function expectResult(m: Model, w: World, s: Spec, call: Call, r: Result, before: { raw: string | null; plainAfterUncertain: boolean }) {
	if (s.fault === "reject" && call.n > 0) {
		expect(r.code, "a 4001 is RPC_FAILED").toBe("RPC_FAILED")
		expect(w.store.getItem(w.key), "I2: a 4001 leaves the stored value as it was").toBe(before.raw)
		w.seen.add("rejected: record restored")
	} else {
		const want = call.sent ? afterSend(s, call.sent) : heldBack(m, s)
		expect({ code: r.code, hash: r.hash }, `I4: the result of ${show(s)} (model: ${showModel(m)})`).toEqual(want)
		w.seen.add(transition(m, w, s, call.sent !== undefined, r.code))
	}
	if (before.plainAfterUncertain) expect([...I3_RESULTS, ...(s.fault === "read" ? ["RPC_FAILED"] : [])], "I3").toContain(r.code)
	if (r.receipt) expectBridge(m, w, s.who, r.receipt)
}

async function runSubmit(m: Model, w: World, s: Spec): Promise<void> {
	const before = { raw: w.store.getItem(w.key), plainAfterUncertain: m.uncertain && !s.override }
	const may = mayCall(m, s)
	// A failed log read stops the guard over an existing record before any send.
	const expectCall = may && (s.fault !== "read" || m.record.kind === "none")
	if (s.override) m.uncertain = false
	w.preflights.record(DEPLOYMENT.id, parties[s.who].recipient, w.aztec, NETWORK)
	w.readFault = s.fault === "read"
	const call: Call = { n: 0 }
	const wallet = walletFor(m, w, s, call, may, before.plainAfterUncertain)
	let r: Result
	try {
		r = await settle(submit(w.ctx, parties[s.who].spend, wallet, w.session, { acceptUncertain: s.override }))
	} finally {
		w.readFault = false
		w.failNextWrite = false
	}
	if (w.violations.length) throw new Error(w.violations.join("\n"))
	expect(call.n, `I1: ${show(s)} reaches the wallet iff that is safe (model: ${showModel(m)})`).toBe(expectCall ? 1 : 0)
	expectResult(m, w, s, call, r, before)
	// A send that already reverted inside this submit resolves it, even when the read that would show it failed.
	if (r.code === "UNCERTAIN" && mayStillLand(m)) m.uncertain = true
}

async function expectStored(m: Model, w: World): Promise<void> {
	const raw = w.store.getItem(w.key)
	if (m.record.kind === "none") return expect(raw, "I2: no record").toBeNull()
	if (m.record.kind === "corrupt") return expect(raw, "I2: the corrupt bytes stay until a send replaces them").toBe(m.record.bytes)
	const { record } = await w.journal.read(NULLIFIER)
	const want = recordOf(m.record.who, m.record.entries.map(attemptOf), m.record.evicted)
	expect(show(record), `I2: the stored record (model: ${showModel(m)})`).toBe(show(want))
}

type Cmd = fc.AsyncCommand<Model, World>

abstract class Step implements Cmd {
	check(_m: Readonly<Model>): boolean {
		return true
	}
	abstract act(m: Model, w: World): Promise<void>
	abstract toString(): string
	async run(m: Model, w: World): Promise<void> {
		w.steps++
		await this.act(m, w)
		await expectStored(m, w)
	}
}

class Submit extends Step {
	constructor(readonly s: Spec) {
		super()
	}
	act(m: Model, w: World) {
		return runSubmit(m, w, this.s)
	}
	toString() {
		return `Submit(${this.s.who}${this.s.override ? ", override" : ""}, ${this.s.send}, ${this.s.fault})`
	}
}

type ChainAction = "land" | "landNoLog" | "revert" | "drop"

/** Acts on the k-th broadcast the chain can still settle. */
class OnChain extends Step {
	constructor(
		readonly action: ChainAction,
		readonly k: number,
	) {
		super()
	}
	targets(m: Readonly<Model>): Broadcast[] {
		if ((this.action === "land" || this.action === "landNoLog") && m.spent) return []
		return m.sent.filter((b) => b.status === "mempool" || (b.status === "dropped" && this.action !== "drop"))
	}
	check(m: Readonly<Model>) {
		return this.targets(m).length > 0
	}
	async act(m: Model, w: World) {
		const targets = this.targets(m)
		const b = targets[this.k % targets.length] as Broadcast
		if (this.action === "drop") {
			w.chain.pending.delete(b.hash)
			b.status = "dropped"
		} else {
			m.uncertain = false
			if (this.action === "revert") revertOn(w, b)
			else await landOn(m, w, b, this.action === "land")
		}
		w.seen.add(this.action)
	}
	toString() {
		return `${this.action}(${this.k})`
	}
}

class Elsewhere extends Step {
	constructor(readonly how: "other" | "spend") {
		super()
	}
	check(m: Readonly<Model>) {
		return !m.spent
	}
	async act(m: Model, w: World) {
		m.uncertain = false
		if (this.how === "other") await landOther(m, w, "A")
		else {
			w.chain.spentAt = w.chain.head
			m.spent = true
		}
		w.seen.add(`elsewhere: ${this.how}`)
	}
	toString() {
		return this.how === "other" ? "LandOther" : "SpendElsewhere"
	}
}

type Corruption = "garbage" | "moved" | "another note"

class Corrupt extends Step {
	constructor(readonly how: Corruption) {
		super()
	}
	async act(m: Model, w: World) {
		const keys = useSession(w.session, DEPLOYMENT.id).secrets.journal
		const valid = recordOf("A", [], false)
		const bytes: Record<Corruption, () => Promise<string>> = {
			garbage: async () => "{not json",
			moved: () => sealRecord(keys, `${STORAGE_PREFIX}elsewhere`, valid),
			"another note": () => sealRecord(keys, w.key, { ...valid, nullifier: NULLIFIER + 1n }),
		}
		const value = await bytes[this.how]()
		w.memory.values.set(w.key, value)
		m.record = { kind: "corrupt", bytes: value }
		w.seen.add("corrupt")
	}
	toString() {
		return `Corrupt(${this.how})`
	}
}

class Reload extends Step {
	async act(_m: Model, w: World) {
		await w.reload()
		w.reloaded = true
		w.seen.add("reload")
	}
	toString() {
		return "Reload"
	}
}

/** A second submit of the note while the first waits in its simulation, past the journal guard. */
class SecondCaller extends Step {
	constructor(
		readonly first: Spec,
		readonly who: Who,
		readonly mustOverlap = false,
	) {
		super()
	}
	async act(m: Model, w: World) {
		const h = hold()
		w.held = h
		const first = runSubmit(m, w, this.first)
		let reached = false
		try {
			reached = await Promise.race([
				h.reached.then(() => true),
				first.then(
					() => false,
					() => false,
				),
			])
			if (reached) await this.rival(m, w)
		} finally {
			// A held first submit keeps the note in `running`, which would refuse every later run's submits.
			h.release()
			w.held = undefined
			await first
		}
		if (this.mustOverlap && !reached) throw new Error("the first submit never reached its simulation, so nothing overlapped")
	}
	async rival(m: Model, w: World) {
		const writeContract = async () => {
			w.fail("I1", m, "a second submit reached the wallet while the first held the note")
			throw new Error("stopped by a violation")
		}
		const wallet = Object.assign(w.chain.wallet(), { writeContract }) as unknown as WalletClient
		w.preflights.record(DEPLOYMENT.id, parties[this.who].recipient, w.aztec, NETWORK)
		const r = await settle(submit(w.ctx, parties[this.who].spend, wallet, w.session, { acceptUncertain: true }))
		if (r.code !== "IN_FLIGHT") w.fail("I1", m, `a second submit gave ${r.code}, not IN_FLIGHT`)
		w.seen.add("second caller: IN_FLIGHT")
	}
	toString() {
		return `SecondCaller(${new Submit(this.first).toString()}, then ${this.who})`
	}
}

async function setup(seen: Set<string>): Promise<{ model: Model; real: World }> {
	const real = new World(seen)
	await real.reload()
	return { model: { sent: [], record: { kind: "none" }, spent: false, logs: false, uncertain: false }, real }
}

const who = fc.constantFrom<Who>("A", "A", "A", "B")
const SIDE = ["revert or drop", "land", "elsewhere", "corrupt", "reload", "second caller"] as const
type Side = (typeof SIDE)[number]
type Swarm = { always: boolean; sends: Send[]; faults: Fault[]; side: Side[] }

/** Each element independently, so every combination, the empty one included, is as likely as any other. */
const someOf = <T>(xs: readonly T[]): fc.Arbitrary<T[]> => fc.tuple(...xs.map(() => fc.boolean())).map((on) => xs.filter((_, i) => on[i]))

/**
 * Swarm generation: each run draws the send modes, faults and side commands it may use, and whether every
 * submit overrides. A spent note ends what a run can explore, so half the runs never spend it; only those
 * reach deep states, such as an eviction after five unresolved sends, often enough.
 */
const swarm: fc.Arbitrary<Swarm> = fc
	.record({
		deep: fc.boolean(),
		always: fc.boolean(),
		ends: someOf<Send>(["land", "landNoLog", "other"]),
		faults: someOf<Fault>(["hashWrite", "ambiguous", "reject", "read"]).map((x): Fault[] => ["none", ...x]),
		side: someOf(SIDE),
	})
	.map(({ deep, ends, side, ...w }) => ({
		...w,
		sends: ["pending", "pending", "revert", "revert", ...(deep ? [] : ends)],
		side: deep ? side.filter((k) => k !== "land" && k !== "elsewhere") : side,
	}))

function commandsOf(w: Swarm): fc.Arbitrary<Cmd> {
	const spec: fc.Arbitrary<Spec> = fc.record({
		override: w.always ? fc.constant(true) : fc.boolean(),
		who,
		send: fc.constantFrom(...w.sends),
		fault: fc.constantFrom(...w.faults),
	})
	const side: Record<Side, fc.Arbitrary<Cmd>> = {
		"revert or drop": fc.tuple(fc.constantFrom<ChainAction>("revert", "drop"), fc.nat(7)).map(([a, k]) => new OnChain(a, k)),
		land: fc.tuple(fc.constantFrom<ChainAction>("land", "landNoLog"), fc.nat(7)).map(([a, k]) => new OnChain(a, k)),
		elsewhere: fc.constantFrom<"other" | "spend">("other", "spend").map((h) => new Elsewhere(h)),
		corrupt: fc.constantFrom<Corruption>("garbage", "moved", "another note").map((h) => new Corrupt(h)),
		reload: fc.constant(new Reload()),
		"second caller": fc.tuple(spec, who).map(([s, x]) => new SecondCaller(s, x)),
	}
	return fc.oneof({ weight: 3, arbitrary: spec.map((s): Cmd => new Submit(s)) }, ...w.side.map((k) => side[k]))
}

const sub = (who: Who, o: Partial<Spec> = {}): Submit => new Submit({ override: false, who, send: "pending", fault: "none", ...o })
const ov = (who: Who, o: Partial<Spec> = {}): Submit => sub(who, { override: true, ...o })

/** Traces too long or exact for random runs to find whole; every transition they reach, random runs must reach too. */
const SCENARIOS: [string, Step[]][] = [
	[
		"an eviction, then the evicted send lands",
		[
			sub("A"),
			new OnChain("drop", 0),
			ov("A"),
			new OnChain("drop", 0),
			ov("A"),
			new OnChain("drop", 0),
			ov("A"),
			new OnChain("drop", 0),
			ov("A"),
			new OnChain("land", 0),
			sub("A"),
		],
	],
	["a new intent while uncertain", [sub("A", { fault: "ambiguous" }), ov("B"), sub("B"), ov("A", { send: "land" })]],
	["a landing without a log", [sub("A", { send: "landNoLog" }), sub("A"), sub("B", { override: true })]],
	["a landing without a log, then a read", [sub("A"), new OnChain("landNoLog", 0), sub("A"), sub("A", { fault: "read" })]],
	["an event with another amount", [sub("A"), new Elsewhere("other"), sub("A"), ov("A")]],
	["another bridge lands first", [sub("A", { send: "other" })]],
	["another bridge lands first, then the hash is lost", [sub("A", { send: "other", fault: "hashWrite" }), sub("A")]],
	[
		"a record that does not open, then the override with a new intent",
		[sub("A", { send: "revert" }), new Corrupt("moved"), sub("B"), ov("B", { send: "land" })],
	],
	[
		"a failed hash write on a pending send, then the override",
		[sub("A", { fault: "hashWrite" }), ov("A", { send: "land" }), new OnChain("revert", 0)],
	],
	["a failed hash write, then a reload", [sub("A", { fault: "hashWrite" }), new Reload(), sub("A"), new OnChain("revert", 0), sub("A")]],
	["an earlier attempt lands", [sub("A"), new OnChain("land", 0), sub("A")]],
	["a rejection keeps the record", [sub("A", { send: "revert" }), sub("A", { fault: "reject" }), sub("A", { send: "land" })]],
	["an overlapping second caller", [new SecondCaller({ override: false, who: "A", send: "land", fault: "none" }, "B", true)]],
]

/** Runs one fixed list and requires every step to have run: a skipped step would leave its scenario untested. */
async function runScenario(seen: Set<string>, steps: Step[]): Promise<void> {
	let world: World | undefined
	await fc.asyncModelRun(async () => {
		const s = await setup(seen)
		world = s.real
		return s
	}, steps)
	expect(world?.steps, "every step of the scenario ran").toBe(steps.length)
}

async function onCurve(from: bigint): Promise<AztecAddress> {
	for (let x = from; ; x++) {
		const a = AztecAddress.fromBigIntUnsafe(x)
		if (await a.isValid()) return a
	}
}

beforeAll(async () => {
	// Deterministic recipients, so a printed seed replays the same addresses.
	for (const [w, from] of [
		["A", 1n],
		["B", 1000n],
	] as const) {
		const recipient = await onCurve(from)
		const spend = await bridgeSpend(recipient)
		const event = { nullifier: NULLIFIER, changeCommitment: spend.change.commitment, amount: AMOUNT, leafIndex: 3n }
		parties[w] = { recipient, spend, messageKey: await bridgeMessageKey(DEPLOYMENT, event, hexToBigInt(spend.secretHash)) }
	}
})

describe("submit, against a model of the chain and the store", () => {
	it.each(SCENARIOS)("%s", (_, steps) => runScenario(new Set(), steps))

	const name = "random command sequences keep I1–I4"
	const p = propertyParams(import.meta.url, name, 400, 20_000)
	it(
		name,
		async () => {
			const seen = new Set<string>()
			await fc.assert(
				fc.asyncProperty(
					swarm.chain((w) => fc.commands([commandsOf(w)], { maxCommands: 16, size: "max", replayPath: p.replayPath })),
					(cmds) => fc.asyncModelRun(() => setup(seen), cmds),
				),
				p.fc,
			)
			// The floor holds at the pull-request seed; a replay or another seed explores, it does not cover.
			if (process.env.FC_PATH || process.env.FC_SEED) return
			const floor = new Set<string>()
			for (const [, steps] of SCENARIOS) await runScenario(floor, steps)
			expect([...floor].filter((t) => !seen.has(t)).sort(), "transitions the fixed scenarios reach and no random run did").toEqual([])
		},
		p.testTimeout,
	)
})
