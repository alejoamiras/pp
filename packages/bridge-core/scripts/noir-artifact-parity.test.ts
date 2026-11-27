import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parityProblems } from "./noir-artifact-parity"

const aztec = join(import.meta.dirname, "../../../contracts/bridge/aztec")
const read = (path: string) => JSON.parse(readFileSync(join(aztec, path), "utf8"))
const hub = read("token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json")
const keystone = read("keystone/target/keystone.json")

describe("parityProblems", () => {
	it("accepts an identical rebuild", async () => {
		expect(await parityProblems("contract", hub, structuredClone(hub))).toEqual([])
		expect(await parityProblems("bin", keystone, structuredClone(keystone))).toEqual([])
	})

	it("catches a renamed parameter, which leaves the class id unchanged", async () => {
		const renamed = structuredClone(hub)
		const fn = renamed.functions.find((f: { abi: { parameters: unknown[] } }) => f.abi.parameters.length > 0)
		fn.abi.parameters[0].name = `${fn.abi.parameters[0].name}_renamed`
		const problems = await parityProblems("contract", hub, renamed)
		expect(problems).toEqual([expect.stringMatching(/^ABI drift at abi\.functions\[\d+\]\.abi\.parameters\[0\]\.name$/)])
	})

	it("catches a program hash change and a program ABI change", async () => {
		const changed = structuredClone(keystone)
		changed.hash = "0"
		changed.abi.return_type = { abi_type: { kind: "field" }, visibility: "public" }
		const problems = await parityProblems("bin", keystone, changed)
		expect(problems[0]).toMatch(/^program hash drift/)
		expect(problems[1]).toBe("ABI drift at abi.return_type")
	})

	it("catches committed program bytecode that the stored hash does not cover", async () => {
		const { bytecode: _, ...stripped } = keystone
		expect(await parityProblems("bin", stripped, keystone)).toEqual(["program bytecode drift"])
	})
})
