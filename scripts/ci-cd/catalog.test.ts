import { expect, test } from "bun:test"
import { resolveSpec } from "../catalog"

test("a catalog reference resolves through the catalog it names, and fails when that holds no entry", () => {
	const root = { catalog: { zod: "4.4.3" }, catalogs: { pool: { viem: "2.45.3" } } }
	expect(resolveSpec("zod", "catalog:", root)).toBe("4.4.3")
	expect(resolveSpec("viem", "catalog:pool", root)).toBe("2.45.3")
	expect(resolveSpec("zod", "^4.6.7", root)).toBe("^4.6.7")
	expect(() => resolveSpec("viem", "catalog:", root)).toThrow(/names no catalog entry/)
	expect(() => resolveSpec("zod", "catalog:pool", root)).toThrow(/names no catalog entry/)
})
