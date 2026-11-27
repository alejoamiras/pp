import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { metadataLeaks, REQUIRED } from "./check-l1-metadata"

const CHECKOUT = "/work/checkout"
let out: string
beforeEach(() => {
	out = mkdtempSync(join(tmpdir(), "l1-metadata-"))
})
afterEach(() => {
	rmSync(out, { recursive: true, force: true })
})

function artifact(path: string, body: object): void {
	mkdirSync(dirname(join(out, path)), { recursive: true })
	writeFileSync(join(out, path), JSON.stringify(body))
}
const clean = { rawMetadata: '{"settings":{"remappings":["@aztec/=node_modules/x/"]}}' }

it("flags a checkout path or an absolute remapping target in an artifact's metadata, and only there", () => {
	for (const r of REQUIRED) artifact(r, clean)
	artifact("Errors.sol/Errors.json", { rawMetadata: `{"sources":{"${CHECKOUT}/x/Errors.sol":{}}}` })
	artifact("Hash.sol/Hash.json", { rawMetadata: '{"settings":{"remappings":["@aztec/=/store/x/"]}}' })
	artifact("build-info/1.json", { source_id_to_path: { 0: `${CHECKOUT}/x/Errors.sol` } })
	expect(metadataLeaks(out, [CHECKOUT]).sort()).toEqual([
		`Errors.sol/Errors.json: 1 absolute path(s), first ${CHECKOUT}/x/Errors.sol`,
		`Errors.sol/Errors.json: metadata contains ${CHECKOUT}`,
		"Hash.sol/Hash.json: 1 absolute path(s), first /store/x/",
	])
})

it("fails an out/ missing the bridge's artifacts or an artifact's metadata, so it cannot pass having read nothing", () => {
	artifact("Errors.sol/Errors.json", { abi: [] })
	expect(metadataLeaks(out, [CHECKOUT])).toEqual([...REQUIRED.map((r) => `${r}: missing`), "Errors.sol/Errors.json: no rawMetadata"])
})
