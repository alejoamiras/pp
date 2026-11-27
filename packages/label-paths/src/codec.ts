import { type AspSnapshot, MAX_LEAVES, SnapshotError, verifySnapshot } from "./snapshot"

const KEYS = ["birthLeaves", "birthRoot", "poolLeaves", "poolRoot", "sequence"]
// p has 77 decimal digits; the cap keeps a hostile body from feeding BigInt a megabyte string.
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/

function decimal(v: unknown, field: string): bigint {
	if (typeof v !== "string" || !DECIMAL.test(v)) throw new SnapshotError("Malformed", field)
	return BigInt(v)
}

function decimals(v: unknown, field: string): bigint[] {
	if (!Array.isArray(v)) throw new SnapshotError("Malformed", field)
	if (v.length > MAX_LEAVES) throw new SnapshotError("TooManyLeaves", field)
	return v.map((x, i) => decimal(x, `${field}[${i}]`))
}

/** Strict: exactly the five keys, every number a decimal string. Verifies both roots before returning. */
export function parseAspSnapshot(json: unknown): AspSnapshot {
	if (typeof json !== "object" || json === null || Array.isArray(json)) throw new SnapshotError("Malformed", "snapshot")
	const o = json as Record<string, unknown>
	if (Object.keys(o).sort().join() !== KEYS.join()) throw new SnapshotError("Malformed", "keys")
	const s: AspSnapshot = {
		sequence: decimal(o.sequence, "sequence"),
		poolRoot: decimal(o.poolRoot, "poolRoot"),
		birthRoot: decimal(o.birthRoot, "birthRoot"),
		poolLeaves: decimals(o.poolLeaves, "poolLeaves"),
		birthLeaves: decimals(o.birthLeaves, "birthLeaves"),
	}
	verifySnapshot(s)
	return s
}

/** The wire form `parseAspSnapshot` reads back; refuses a snapshot that does not verify. */
export function serializeAspSnapshot(s: AspSnapshot): string {
	verifySnapshot(s)
	return JSON.stringify({
		sequence: s.sequence.toString(),
		poolRoot: s.poolRoot.toString(),
		birthRoot: s.birthRoot.toString(),
		poolLeaves: s.poolLeaves.map(String),
		birthLeaves: s.birthLeaves.map(String),
	})
}
