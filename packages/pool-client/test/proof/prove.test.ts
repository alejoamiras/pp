import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ProofService } from "@0xbow/privacy-pools-v2-sdk"
import { afterAll, describe, expect, it } from "vitest"
import { createArtifacts, createProver, PoolClientError } from "../../src/index.ts"
import { offlineTransactWitness } from "../support/offline-witness.ts"
import { circuitsDir, PACKAGE_DIR, scratchDir } from "../support/paths.ts"

const runtime = "Bun" in globalThis ? `bun ${Bun.version}` : `node ${process.versions.node}`
const scratch = scratchDir("prove")
afterAll(() => scratch.remove())

describe("transact_1x1 with no chain", () => {
	it("proves and verifies through ProofService with this package's prover and verified artifacts", async () => {
		const spend = await offlineTransactWitness()
		const artifacts = createArtifacts({ kind: "dir", path: circuitsDir() })
		const proofs = new ProofService({ circuitArtifacts: artifacts, groth16Prover: createProver() })

		const t0 = performance.now()
		await artifacts.ensure("transact_1x1")
		const t1 = performance.now()
		const result = await proofs.proveTransact(spend.witness as never, 1, 1)
		const t2 = performance.now()
		expect(await proofs.verifyTransact(result, 1, 1)).toBe(true)
		const t3 = performance.now()
		console.log(
			`[pool-client] transact_1x1 on ${runtime}: load ${Math.round(t1 - t0)} ms, prove ${Math.round(t2 - t1)} ms, verify ${Math.round(t3 - t2)} ms`,
		)

		const signals = result.publicSignals.map(BigInt)
		expect(signals).toHaveLength(8)
		expect(signals[0]).toBe(spend.nullifier)
		expect(signals[1]).toBe(spend.changeCommitment)
		expect(signals[5]).toBe(spend.amount)
		expect(signals[6]).toBe(spend.asset)
		expect(signals[7]).toBe(spend.context)
	})

	it("refuses a zkey with one changed byte as ARTIFACT_MISMATCH, and the prover never sees it", async () => {
		const src = join(circuitsDir(), "transact_1x1")
		const dst = join(scratch.path, "transact_1x1")
		mkdirSync(join(dst, "transact_1x1_js"), { recursive: true })
		symlinkSync(join(src, "transact_1x1_js/transact_1x1.wasm"), join(dst, "transact_1x1_js/transact_1x1.wasm"))
		symlinkSync(join(src, "groth16_vkey.json"), join(dst, "groth16_vkey.json"))
		const zkey = readFileSync(join(src, "groth16_pkey.zkey"))
		zkey[zkey.length >> 1]! ^= 1
		writeFileSync(join(dst, "groth16_pkey.zkey"), zkey)

		const artifacts = createArtifacts({ kind: "dir", path: scratch.path })
		const err = await artifacts.ensure("transact_1x1").catch((e: unknown) => e)
		expect(err).toBeInstanceOf(PoolClientError)
		expect(err).toMatchObject({ code: "ARTIFACT_MISMATCH", circuit: "transact_1x1", file: "provingKey" })

		const proofs = new ProofService({ circuitArtifacts: artifacts, groth16Prover: createProver() })
		const spend = await offlineTransactWitness()
		await expect(proofs.proveTransact(spend.witness as never, 1, 1)).rejects.toThrow(/provingKey: sha256 differs/)
	})

	it.runIf("Bun" in globalThis)("resolves one snarkjs copy for the SDK and this package under Bun", () => {
		const sdkDir = dirname(Bun.resolveSync("@0xbow/privacy-pools-v2-sdk", PACKAGE_DIR))
		expect(realpathSync(Bun.resolveSync("snarkjs", sdkDir))).toBe(realpathSync(Bun.resolveSync("snarkjs", PACKAGE_DIR)))
	})
})
