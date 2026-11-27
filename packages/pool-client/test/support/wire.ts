/** JSON that keeps bigints, for values crossing `page.evaluate`. */
export const encode = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x))

export const decode = <T>(s: string): T =>
	JSON.parse(s, (_k, x) => (x && typeof x === "object" && "$bigint" in x ? BigInt((x as { $bigint: string }).$bigint) : x)) as T
