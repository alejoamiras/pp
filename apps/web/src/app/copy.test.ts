import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { RECOVERY_PRECISE } from "./copy"

describe("recovery copy", () => {
	test("the README carries the precise sentence verbatim", () => {
		expect(readFileSync(new URL("../../README.md", import.meta.url), "utf8")).toContain(RECOVERY_PRECISE)
	})
})
