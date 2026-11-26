import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { aztecVersion, cratesWith, gitDeps, loadManifest, parseManifest, passedCount, pinProblems, ROOT, txeBuild } from "./crates"

const manifest = loadManifest()
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim()

describe("contracts/crates.json", () => {
	test("lists every Noir crate in the repository", () => {
		const onDisk = [...new Bun.Glob("contracts/**/Nargo.toml").scanSync({ cwd: ROOT })]
			.filter((f) => !/\/(node_modules|target)\//.test(f))
			.map(dirname)
			.sort()
		expect(manifest.crates.map((c) => c.path).sort()).toEqual(onDisk)
	})

	test("pins every git dependency tag a crate declares, and nothing else", () => {
		const declared = new Set(manifest.crates.flatMap((c) => gitDeps(ROOT, c).map((d) => `${d.repo}@${d.tag}`)))
		expect(manifest.pins.map((p) => `${p.repo}@${p.tag}`).sort()).toEqual([...declared].sort())
	})

	test("pins one aztec-nr version, the npm line's", () => {
		const core = JSON.parse(readFileSync(join(ROOT, "packages/bridge-core/package.json"), "utf8"))
		expect(aztecVersion(manifest)).toBe(core.dependencies["@aztec-labs/aztec.js"])
	})

	test("each TXE crate's list names at least its floor, and each parity crate has a committed artifact", () => {
		for (const c of cratesWith(manifest, "txe")) {
			const names = readFileSync(join(ROOT, c.path, "txe-manifest.txt"), "utf8").match(/^[A-Za-z_]\w*$/gm) ?? []
			expect(new Set(names).size, c.name).toBeGreaterThanOrEqual(c.txe?.floor ?? Number.POSITIVE_INFINITY)
		}
		for (const c of cratesWith(manifest, "parity")) {
			expect(git(ROOT, "ls-files", "--", `${c.path}/target/*.json`), c.name).not.toBe("")
		}
	})

	// The server loads each staged artifact, so a crate's own one staged elsewhere is rebuilt first.
	test("a TXE suite rebuilds every crate whose artifact it stages, then itself", () => {
		const probe = { name: "probe", path: "contracts/bridge/aztec/asp_registry_probe", kind: "contract", parity: true }
		const registry = { name: "registry", path: "contracts/bridge/aztec/asp_registry", kind: "contract", parity: true }
		const stage = ["contracts/bridge/aztec/asp_registry/target/asp_registry-AspRootRegistry.json", "packages/x/token.json"]
		const m = parseManifest({ crates: [{ ...probe, txe: { floor: 1, stage } }, registry], pins: [] })
		expect(txeBuild(m, "probe")).toEqual(["registry", "probe"])
		for (const c of cratesWith(manifest, "txe")) expect(txeBuild(manifest, c.name).at(-1)).toBe(c.name)
	})

	test("refuses an entry that disagrees with the crate or the schema", () => {
		const hub = { name: "token_bridge_hub", path: "contracts/bridge/aztec/token_bridge_hub", kind: "contract" }
		const lib = { name: "claim_secret", path: "contracts/bridge/aztec/claim_secret", kind: "lib" }
		const pin = { repo: "noir-lang/keccak256", tag: "v0.1.3", commit: "f".repeat(40) }
		const cases: [unknown, RegExp][] = [
			[{ crates: [{ ...hub, kind: "lib" }], pins: [] }, /differs from Nargo.toml's type contract/],
			[{ crates: [{ ...hub, partiy: true }], pins: [] }, /unknown key partiy/],
			[{ crates: [{ ...lib, parity: true }], pins: [] }, /a lib crate builds no artifact/],
			[{ crates: [hub, { ...hub, name: "again" }], pins: [] }, /token_bridge_hub is listed twice/],
			[{ crates: [{ ...hub, nargo: { floor: 0 } }], pins: [] }, /floor must be a positive integer/],
			[{ crates: [lib], pins: [{ ...pin, commit: "abc" }] }, /full 40-hex sha/],
			[{ crates: [{ ...lib, path: "../outside" }], pins: [] }, /repo-relative/],
			[{ crates: [{ ...lib, nargo: { check: "scripts/ci-cd/crates.ts", floor: 1 } }], pins: [] }, /nargo.check stands alone/],
			[{ crates: [{ ...lib, nargo: { check: "scripts/missing.ts" } }], pins: [] }, /repo-relative script/],
		]
		for (const [input, error] of cases) expect(() => parseManifest(input), String(error)).toThrow(error)
	})
})

test("passedCount sums every package's line through colour codes", () => {
	expect(passedCount("[a] 10 tests passed\n\x1b[32m[b] 1 test passed\x1b[0m\n")).toBe(11)
	expect(passedCount("[a] 0 tests passed\n")).toBe(0)
})

test("pinProblems accepts the recorded commit and names a moved or missing tag", () => {
	const home = mkdtempSync(join(tmpdir(), "pp-pins-"))
	try {
		const repo = join(home, "github.com/o/r/v1")
		mkdirSync(repo, { recursive: true })
		writeFileSync(join(repo, "lib.nr"), "fn main() {}\n")
		git(repo, "init", "-q")
		git(repo, "add", ".")
		git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "x")
		const head = git(repo, "rev-parse", "HEAD")
		expect(pinProblems([{ repo: "o/r", tag: "v1", commit: head }], home)).toEqual([])
		expect(pinProblems([{ repo: "o/r", tag: "v1", commit: "0".repeat(40) }], home)[0]).toContain(`resolved to ${head}`)
		expect(pinProblems([{ repo: "o/r", tag: "v2", commit: head }], home)[0]).toContain("is not fetched")
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
})
