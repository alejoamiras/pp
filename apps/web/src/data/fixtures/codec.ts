/** JSON with bigints, for the fixture world's `sessionStorage` copy: a bigint is written as `{ "$n": "<decimal>" }`. */

export function encode(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? { $n: v.toString() } : v))
}

export function decode(text: string): unknown {
	return JSON.parse(text, (_key, v: unknown) => {
		if (typeof v === "object" && v !== null && Object.keys(v).length === 1 && typeof (v as { $n?: unknown }).$n === "string") {
			return BigInt((v as { $n: string }).$n)
		}
		return v
	})
}
