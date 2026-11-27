import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { concat, type Hex, keccak256, numberToHex, size } from "viem"
import { describe, expect, it } from "vitest"
import {
	buildMismatch,
	CREATION_CODES,
	checkedForgeOut,
	creationCodeHash,
	deployBuildMismatch,
	forgeArtifact as artifact,
	stripMetadata,
} from "./creation"
import { scratchHome } from "./test-support"

describe("creation-code hashes", () => {
	it("hash the code without its trailing metadata, so only what the code does is compared", () => {
		const body: Hex = "0x6080604052"
		const meta = (seed: string): Hex => concat([keccak256(`0x${seed}`), numberToHex(32, { size: 2 })])
		expect(stripMetadata(concat([body, meta("01")]))).toBe(body)
		expect(creationCodeHash(concat([body, meta("01")]))).toBe(creationCodeHash(concat([body, meta("02")])))
		expect(() => stripMetadata(concat(["0x01", numberToHex(9, { size: 2 })]))).toThrow(/overruns/)
	})

	// The build is forge's output, which only the contracts job and a prepared checkout have.
	it.skipIf(!existsSync(artifact("PortalFactory")))("equal the committed list for every contract a keyed run broadcasts", () => {
		for (const [name, want] of Object.entries(CREATION_CODES)) {
			const code = JSON.parse(readFileSync(artifact(name), "utf8")).bytecode.object as Hex
			expect({ hash: creationCodeHash(code), size: size(code) }, name).toEqual(want)
		}
		expect(buildMismatch()).toBeUndefined()
	})
})

describe("the build deploy checks", () => {
	it("is a rehearsal's own copy only under --rehearse, and the checkout's build in every other mode", () => {
		const env = { PP_TESTNET_FORGE_OUT: "/case/out" }
		const own = checkedForgeOut({ kind: "live" }, {})
		expect(checkedForgeOut({ kind: "rehearse" }, env)).toBe("/case/out")
		for (const kind of ["live", "rehearse-fork"]) expect(checkedForgeOut({ kind }, env)).toBe(own)
		expect(checkedForgeOut({ kind: "rehearse" }, { PP_TESTNET_FORGE_OUT: "" })).toBe(own)
	})

	it.skipIf(!existsSync(artifact("PortalFactory")))(
		"refuses a stale checkout even beside a good copy, since the checkout is what broadcasts",
		() => {
			const real = readFileSync(artifact("PortalFactory"), "utf8")
			const parsed = JSON.parse(real) as { bytecode: { object: string } }
			const code = parsed.bytecode.object
			parsed.bytecode.object = `${code.slice(0, 10)}${code[10] === "0" ? "1" : "0"}${code.slice(11)}`
			const root = scratchHome()
			const out = (name: string, text: string) => {
				const dir = join(root, name)
				mkdirSync(dirname(artifact("PortalFactory", dir)), { recursive: true })
				writeFileSync(artifact("PortalFactory", dir), text)
				return dir
			}
			const [good, stale] = [out("good", real), out("stale", JSON.stringify(parsed))]
			const rehearse = { kind: "rehearse" }
			expect(deployBuildMismatch(rehearse, { PP_TESTNET_FORGE_OUT: good }, stale)).toMatch(/^PortalFactory: /)
			expect(deployBuildMismatch(rehearse, { PP_TESTNET_FORGE_OUT: stale }, good)).toMatch(/^PortalFactory: /)
			expect(deployBuildMismatch({ kind: "live" }, { PP_TESTNET_FORGE_OUT: stale }, good)).toBeUndefined()
			expect(deployBuildMismatch(rehearse, { PP_TESTNET_FORGE_OUT: good }, good)).toBeUndefined()
		},
	)
})
