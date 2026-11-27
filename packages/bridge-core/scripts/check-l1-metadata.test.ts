import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { metadataLeaks } from "./check-l1-metadata"

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
function bridge(name: string, code = "0x6080"): void {
	const meta = { settings: { compilationTarget: { [`src/${name}.sol`]: name }, remappings: ["@aztec/=node_modules/x/"] } }
	artifact(`${name}.sol/${name}.json`, { rawMetadata: JSON.stringify(meta), bytecode: { object: code } })
}
const astOnly = (absolutePath: string) => ({ ast: { absolutePath }, abi: [], bytecode: { object: "0x" } })

it("flags a checkout path, an absolute remapping context or a foreign absolute target, and only in metadata", () => {
	bridge("PortalFactory")
	bridge("ProcessorPortalImpl")
	artifact("Errors.sol/Errors.json", { rawMetadata: `{"sources":{"${CHECKOUT}/x/Errors.sol":{}}}` })
	artifact("Hash.sol/Hash.json", { rawMetadata: '{"settings":{"remappings":["/ctx/:@a/=node_modules/a/","@b/=C:\\\\store\\\\"]}}' })
	artifact("IERC20.sol/IERC20.json", astOnly("lib/x/IERC20.sol"))
	artifact("build-info/1.json", { source_id_to_path: { 0: `${CHECKOUT}/x/Errors.sol` } })
	expect(metadataLeaks(out, [CHECKOUT]).sort()).toEqual([
		`Errors.sol/Errors.json: 1 absolute path(s), first ${CHECKOUT}/x/Errors.sol`,
		`Errors.sol/Errors.json: metadata contains ${CHECKOUT}`,
		"Hash.sol/Hash.json: 2 absolute path(s), first /ctx/",
	])
})

it("fails an out/ without the bridge's compiled artifacts or a contract's metadata, so it cannot pass having read nothing", () => {
	bridge("PortalFactory", "0x")
	artifact("Errors.sol/Errors.json", { abi: [{ type: "error" }], bytecode: { object: "0x" } })
	artifact("IERC20.sol/IERC20.json", astOnly(`${CHECKOUT}/x/IERC20.sol`))
	expect(metadataLeaks(out, [CHECKOUT])).toEqual([
		"PortalFactory.sol/PortalFactory.json: not src/PortalFactory.sol's compiled PortalFactory",
		"ProcessorPortalImpl.sol/ProcessorPortalImpl.json: missing",
		"Errors.sol/Errors.json: no rawMetadata",
		`IERC20.sol/IERC20.json: absolute source name ${CHECKOUT}/x/IERC20.sol`,
	])
})
