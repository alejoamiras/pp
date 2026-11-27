import type { RootRecord } from "@pp/label-paths"

/**
 * The parent and the bot's child process speak JSON lines: the child writes events to stdout, the
 * parent writes commands to stdin. Every bigint crosses as a decimal string.
 */
export type ReadyEvent = { event: "ready"; url: string; port: number; poster: string; birthIntake: string }
export type PostNowReply = { event: "post-now"; id: number } & (
	| { ok: true; record: Record<keyof RootRecord, string> }
	| { ok: false; reason: string }
)
export type PostNowCommand = { cmd: "post-now"; id: number }

export const line = (value: object): string => `${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`

// A key per field, so a field `RootRecord` gains fails the build here instead of vanishing on the wire.
const FIELD_SET: Record<keyof RootRecord, true> = {
	sequence: true,
	poolRoot: true,
	birthRoot: true,
	l1Block: true,
	rootTime: true,
	poolSize: true,
	birthSize: true,
}
const FIELDS = Object.keys(FIELD_SET) as (keyof RootRecord)[]

export const encodeRecord = (r: RootRecord): Record<keyof RootRecord, string> =>
	Object.fromEntries(FIELDS.map((k) => [k, r[k].toString()])) as Record<keyof RootRecord, string>

export const decodeRecord = (w: Record<keyof RootRecord, string>): RootRecord =>
	Object.fromEntries(FIELDS.map((k) => [k, BigInt(w[k])])) as RootRecord

/** A parsed line, or `null` for one that is not a JSON object (a stray print from a dependency). */
export function parseLine(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text)
		return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null
	} catch {
		return null
	}
}
