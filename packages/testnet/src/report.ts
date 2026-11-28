/**
 * The canary's `report.json` and its exit classes. The file is rebuilt from a field allowlist on every
 * write, so a value the canary never meant to record (a key, secret, signature or claim salt, or a
 * library's message) has no field to land in; what it writes is also scrubbed of every loaded value.
 */
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BridgeClientError } from "@pp/bridge-core"
import { GuardError } from "./errors"
import { redact } from "./redact"

/** Each exit class and its process exit code. */
export const EXIT_CODES = {
	PASS: 0,
	FAILED: 1,
	/** The one-transaction deploy and claim was sent and its fate is open: nothing else is sent. */
	I10_UNRESOLVED: 1,
	REFUSED: 2,
	/** No Outbox root covered a burn within the epoch-proof budget. */
	EPOCH_PROOF_TIMEOUT: 3,
} as const

export type ExitClass = keyof typeof EXIT_CODES

/** A failure the canary words itself; `errorClass` is an identifier, never a value. */
export class CanaryError extends Error {
	override readonly name = "CanaryError"
	constructor(
		readonly exitClass: ExitClass,
		readonly errorClass: string,
		detail: string,
	) {
		super(`${errorClass}: ${detail}`)
	}
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

export type Outcome = { exitClass: ExitClass; exitCode: number; errorClass?: string }

/** The exit class, code and error class of a run that ended with `e` (undefined: it passed). */
export function outcomeOf(e: unknown): Outcome {
	const of = (exitClass: ExitClass, errorClass?: string): Outcome => ({
		exitClass,
		exitCode: EXIT_CODES[exitClass],
		...(errorClass === undefined ? {} : { errorClass }),
	})
	if (e === undefined) return of("PASS")
	if (e instanceof GuardError) return of("REFUSED", e.guard)
	if (e instanceof CanaryError) return of(e.exitClass, e.errorClass)
	if (e instanceof BridgeClientError) return of("FAILED", e.code)
	return of("FAILED", e instanceof Error && IDENTIFIER.test(e.name) ? e.name : "Error")
}

export const STEPS = [
	"attach",
	"account",
	"bridge",
	"claimable",
	"deployClaim",
	"selfTransfer",
	"shield",
	"ragequit",
	"epochProof",
	"settle",
] as const
export type Step = (typeof STEPS)[number]

/** Named waits, apart from the steps that contain them. */
export const WAITS = ["claimable", "bridgeFinality", "birthRoot", "epochProof"] as const
export type Wait = (typeof WAITS)[number]

/** Top-level fields that hold a primitive or a list of primitives. */
const SCALARS = [
	"version",
	"command",
	"target",
	"l1ChainId",
	"startedAt",
	"endedAt",
	"exitClass",
	"exitCode",
	"errorClass",
	"oneTx",
	"oneTxError",
	"bridgeL1Tx",
	"bridgeL1Block",
	"balanceDelta",
	"unsettled",
] as const

/** Top-level maps of milliseconds, keyed by a closed set of names. */
const TIMINGS = { steps: STEPS, waits: WAITS } as const

/** Top-level lists of entries, each entry limited to these fields. */
const ENTRIES = {
	/** Every L2 transaction the canary proved, in order. */
	sends: ["step", "txHash", "provingMs", "inclusionMs", "checkpointMs", "outcome"],
	/** Every checked spend's checks against its proof's anchor. */
	checks: [
		"step",
		"txHash",
		"anchorBlock",
		"anchorTime",
		"sequence",
		"l1Block",
		"l1BlockHash",
		"poolRootParity",
		"rootTimeParity",
		"marginSec",
		"failed",
	],
	burns: ["txHash", "amount"],
	settles: ["l2TxHash", "l1TxHash", "amount"],
} as const

type Primitive = string | number | bigint | boolean
const isPrimitive = (v: unknown): v is Primitive => ["string", "number", "bigint", "boolean"].includes(typeof v)
const isPlain = (v: unknown): boolean => isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive))

function pick(o: unknown, fields: readonly string[], keep: (v: unknown) => boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	if (typeof o !== "object" || o === null) return out
	for (const k of fields) {
		const v = (o as Record<string, unknown>)[k]
		if (v !== undefined && keep(v)) out[k] = v
	}
	return out
}

/** `raw` reduced to the allowlisted fields, each holding only the shape its field allows. */
export function allowlisted(raw: Record<string, unknown>): Record<string, unknown> {
	const out = pick(raw, SCALARS, isPlain)
	for (const [field, names] of Object.entries(TIMINGS)) {
		const timings = pick(raw[field], names, (v) => typeof v === "number")
		if (Object.keys(timings).length) out[field] = timings
	}
	for (const [field, names] of Object.entries(ENTRIES)) {
		const list = raw[field]
		if (Array.isArray(list)) out[field] = list.map((e) => pick(e, names, isPlain))
	}
	return out
}

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)

/** `report.json`'s text: the allowlisted fields, scrubbed of every value this process loaded. */
export const reportText = (raw: Record<string, unknown>): string => `${redact(JSON.stringify(allowlisted(raw), bigints, "\t"))}\n`

type EntryField = keyof typeof ENTRIES

/** One run's report, rewritten in full to `<dir>/report.json` (0600) on every `flush`. */
export class CanaryReport {
	readonly path: string
	private readonly raw: Record<string, unknown>
	private readonly started = Date.now()

	constructor(dir: string, base: { command: string; target: string; l1ChainId: number }) {
		this.path = join(dir, "report.json")
		this.raw = { version: 1, ...base, startedAt: new Date(this.started).toISOString(), steps: {}, waits: {} }
	}

	set(field: (typeof SCALARS)[number], value: Primitive | Primitive[]): void {
		this.raw[field] = value
	}

	push(field: EntryField, entry: Record<string, Primitive | Primitive[] | undefined>): void {
		this.raw[field] = [...((this.raw[field] as unknown[]) ?? []), entry]
	}

	wait(name: Wait, ms: number): void {
		;(this.raw.waits as Record<string, number>)[name] = Math.round(ms)
	}

	/** Runs `f` as step `name`, recording its wall-clock even when it throws. */
	async step<T>(name: Step, f: () => Promise<T>): Promise<T> {
		const t0 = performance.now()
		try {
			return await f()
		} finally {
			;(this.raw.steps as Record<string, number>)[name] = Math.round(performance.now() - t0)
		}
	}

	/** Written whole and renamed into place, so an interrupted write never loses what an earlier one recorded. */
	flush(): string {
		const tmp = `${this.path}.${process.pid}.tmp`
		writeFileSync(tmp, reportText(this.raw), { mode: 0o600 })
		renameSync(tmp, this.path)
		return this.path
	}

	/** Records the outcome and the end time, and writes the file. */
	finish(o: Outcome): string {
		this.raw.exitClass = o.exitClass
		this.raw.exitCode = o.exitCode
		if (o.errorClass !== undefined) this.raw.errorClass = o.errorClass
		this.raw.endedAt = new Date().toISOString()
		return this.flush()
	}
}
