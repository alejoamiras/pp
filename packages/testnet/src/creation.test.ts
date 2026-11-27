import { existsSync, readFileSync } from "node:fs"
import { concat, type Hex, keccak256, numberToHex, size } from "viem"
import { describe, expect, it } from "vitest"
import { buildMismatch, CREATION_CODES, creationCodeHash, forgeArtifact as artifact, stripMetadata } from "./creation"

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
