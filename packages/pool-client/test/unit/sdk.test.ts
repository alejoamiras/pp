import { expect, it } from "vitest"
import { SDK_VALUES } from "../../src/sdk.ts"

it("every SDK value this package imports is defined at run time", () => {
	const missing = Object.entries(SDK_VALUES).filter(([, v]) => v === undefined)
	expect(missing).toEqual([])
})
