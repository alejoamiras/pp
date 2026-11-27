import { describe, expect, it } from "vitest"
import { checkAttestation, verifyArgs } from "./pin-wallet"

const commit = "be2280a88a0b1c2d3e4f5061728394a5b6c7d8e9"
const release = "https://github.com/nulo-sh/nulo/.github/workflows/release.yml@refs/heads/main"

describe("the wallet pin's attestation", () => {
	it("asks gh to verify only the release workflow's signature, built on a hosted runner", () => {
		const args = verifyArgs("w.zip")
		expect(args.slice(args.indexOf("--signer-workflow"), args.indexOf("--signer-workflow") + 2)).toEqual([
			"--signer-workflow",
			"nulo-sh/nulo/.github/workflows/release.yml",
		])
		expect(args).toContain("--deny-self-hosted-runners")
	})

	it.each([
		["another workflow of the repo", { sourceRepositoryDigest: commit, buildSignerURI: release.replace("release.yml", "ci.yml") }],
		["another commit", { sourceRepositoryDigest: "0".repeat(40), buildSignerURI: release }],
	])("refuses a certificate from %s", (_why, cert) => {
		expect(() => checkAttestation(cert, commit)).toThrow()
	})

	it("accepts the release workflow's certificate for the tag's commit", () => {
		expect(checkAttestation({ sourceRepositoryDigest: commit, buildSignerURI: release, runInvocationURI: "r" }, commit)).toEqual({
			signer: release,
			run: "r",
		})
	})
})
