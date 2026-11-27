import { expect, test } from "bun:test"
import { resolveSpec } from "../catalog"

test("a catalog reference resolves through the catalog it names, and fails when that holds no entry", () => {
	const root = { catalog: { zod: "4.6.7" }, catalogs: { pool: { viem: "2.45.3" } } }
	expect(resolveSpec("zod", "catalog:", root)).toBe("4.6.7")
	expect(resolveSpec("viem", "catalog:pool", root)).toBe("2.45.3")
	expect(resolveSpec("zod", "^4.6.7", root)).toBe("^4.6.7")
	expect(() => resolveSpec("viem", "catalog:", root)).toThrow(/names no catalog entry/)
	expect(() => resolveSpec("zod", "catalog:pool", root)).toThrow(/names no catalog entry/)
})

test("the default catalog has Bun's two spellings and two homes, and only own string entries count", () => {
	expect(resolveSpec("zod", "catalog:default", { catalog: { zod: "4.6.7" } })).toBe("4.6.7")
	expect(resolveSpec("zod", "catalog: ", { catalogs: { default: { zod: "4.6.7" } } })).toBe("4.6.7")
	expect(() => resolveSpec("zod", "catalog:", { catalog: { zod: "4.6.7" }, catalogs: { default: { zod: "4.6.7" } } })).toThrow(
		/both catalog and catalogs.default/,
	)
	expect(() => resolveSpec("constructor", "catalog:", { catalog: {} })).toThrow(/names no catalog entry/)
	expect(() => resolveSpec("toString", "catalog:pool", { catalogs: { pool: {} } })).toThrow(/names no catalog entry/)
	for (const bad of [null, "", " ", 4])
		expect(() => resolveSpec("zod", "catalog:", { catalog: { zod: bad } }), String(bad)).toThrow(/names no catalog entry/)
})
