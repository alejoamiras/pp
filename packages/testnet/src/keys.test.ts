import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ITEM, RUN_KEYS } from "./keys"

const DIR = fileURLToPath(new URL("../env/", import.meta.url))
const lines = (file: string) =>
	readFileSync(`${DIR}${file}`, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
const assignments = (file: string) => lines(file).filter((l) => !l.startsWith("#"))
const ref = (name: string) => `PP_TESTNET_${name}=${ITEM}/PP_TESTNET_${name}`
const allNames = [...new Set(Object.values(RUN_KEYS).flatMap((specs) => specs.map((s) => s.name)))]

describe("the keyed-run templates", () => {
	it("hold one template per keyed run, each naming exactly its run's variables as refs to the one item", () => {
		expect(readdirSync(DIR).sort()).toEqual([...Object.keys(RUN_KEYS).map((r) => `${r}.env.example`), "provision.env.example"].sort())
		for (const [run, specs] of Object.entries(RUN_KEYS)) {
			expect(assignments(`${run}.env.example`)).toEqual(specs.map((s) => ref(s.name)))
			expect(lines(`${run}.env.example`).some((l) => l.startsWith("# op:"))).toBe(false)
		}
	})

	it("provision every variable once, each with the directive its kind needs", () => {
		const text = lines("provision.env.example")
		expect(assignments("provision.env.example").sort()).toEqual(allNames.map(ref).sort())
		for (const specs of Object.values(RUN_KEYS))
			for (const { name, kind } of specs) {
				const at = text.indexOf(ref(name))
				expect(text[at - 1]).toBe(kind === "l1" ? "# op: generate eth-key" : "# op: generate fr")
			}
	})
})
