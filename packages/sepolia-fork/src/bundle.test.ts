import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { bundleDigest, bundleDir, CIRCUITS } from "./bundle.ts"
import { DEFAULT_TARGET, TARGETS } from "./pins.ts"

const parent = join(homedir(), ".cache/pp/fork")
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, "bundle-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("a cached bundle is hashed again on every run, refused naming the file that breaks a pin, and never refetched", async () => {
	const { bundle } = TARGETS[DEFAULT_TARGET]
	expect(bundleDigest(bundle)).toMatch(/^[0-9a-f]{16}$/)
	const dir = join(root, bundleDigest(bundle))
	for (const c of CIRCUITS) {
		mkdirSync(join(dir, c, `${c}_js`), { recursive: true })
		writeFileSync(join(dir, c, `${c}_js`, `${c}.wasm`), "not the pinned wasm")
		writeFileSync(join(dir, c, "groth16_pkey.zkey"), "not the pinned key")
		writeFileSync(join(dir, c, "groth16_vkey.json"), "{}")
	}
	let fetched = 0
	const err = await bundleDir({
		bundle,
		root,
		fetch: (async () => {
			fetched++
			throw new Error("no network in a unit test")
		}) as never,
	}).catch((e: unknown) => e)
	expect(err).toMatchObject({ code: "ARTIFACT_MISMATCH", message: expect.stringMatching(/ deposit (wasm|provingKey|verificationKey): /) })
	expect(fetched).toBe(0)
})

test("each target names the bundle its verifiers embed, and each bundle caches apart", () => {
	expect([TARGETS.pool1.bundle, TARGETS["vault-323c"].bundle]).toEqual(["ceremony", "pre-ceremony"])
	expect(bundleDigest("ceremony")).not.toBe(bundleDigest("pre-ceremony"))
})
