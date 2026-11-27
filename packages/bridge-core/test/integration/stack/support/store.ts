import { toHex } from "viem"
import type { KeyValueStore } from "../../../../src/client/journal"

/**
 * A journal store that keeps every value, counts writes and can fail chosen ones: what a browser's
 * `localStorage` does, plus a quota error on demand.
 */
export function recordingStore() {
	const values = new Map<string, string>()
	const control = { writes: 0, failWrite: (_n: number) => false }
	const store: KeyValueStore = {
		getItem: (k) => values.get(k) ?? null,
		setItem: (k, v) => {
			if (control.failWrite(++control.writes)) throw new DOMException("quota", "QuotaExceededError")
			values.set(k, v)
		},
		removeItem: (k) => void values.delete(k),
	}
	return { store, values, control }
}

/** Each way a field value could sit in a stored string: decimal, 0x hex (padded or not) and bare hex. */
export function encodings(v: bigint | string): string[] {
	if (typeof v === "string") return [v.toLowerCase(), v.toLowerCase().replace(/^0x/, "")]
	const hex = v.toString(16)
	return [v.toString(), `0x${hex}`, toHex(v, { size: 32 }).slice(2), hex].filter((s) => s.length >= 4)
}

/** The fields whose value shows up, in any encoding, in a key or value of `values`. */
export function leaks(values: ReadonlyMap<string, string>, fields: Record<string, bigint | string>): string[] {
	const text = [...values].flat().join("\n").toLowerCase()
	return Object.entries(fields)
		.filter(([, v]) => encodings(v).some((e) => text.includes(e)))
		.map(([name]) => name)
}
