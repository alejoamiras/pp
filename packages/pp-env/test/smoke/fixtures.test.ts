import { afterAll, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { buildFixtures, FIXTURES_DIR, withFixtureLock } from "../../src/env/deploy.ts"

const parent = join(homedir(), ".cache/pp/pp-env")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "fixtures-layout-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Links `pkg` into `nodeModules` from a store outside the package, as Bun's isolated linker does in a workspace. */
function linkFromStore(nodeModules: string, pkg: string): void {
	const real = realpathSync(dirname(Bun.resolveSync(`${pkg}/package.json`, FIXTURES_DIR)))
	const stored = join(dir, "store", pkg)
	mkdirSync(dirname(stored), { recursive: true })
	symlinkSync(real, stored)
	mkdirSync(dirname(join(nodeModules, pkg)), { recursive: true })
	symlinkSync(stored, join(nodeModules, pkg))
}

test(
	"the fixtures build when their dependencies are linked from a store outside the package",
	async () => {
		const contracts = join(dir, "workspace/packages/pp-env/contracts")
		for (const part of ["foundry.toml", "src", "test"]) cpSync(join(FIXTURES_DIR, part), join(contracts, part), { recursive: true })
		const nodeModules = join(dir, "workspace/packages/pp-env/node_modules")
		for (const pkg of ["forge-std", "@openzeppelin/contracts"]) linkFromStore(nodeModules, pkg)
		await buildFixtures(true, contracts)
		for (const name of ["StubProcessor", "TestToken"])
			expect(existsSync(join(contracts, "out", `${name}.sol`, `${name}.json`))).toBe(true)
	},
	{ timeout: 120_000 },
)

test("the fixture CLI waits while another forge command holds the project", async () => {
	const cli = await withFixtureLock(FIXTURES_DIR, async () => {
		const proc = Bun.spawn(["bun", join(import.meta.dir, "../../scripts/forge-fixtures.ts"), "config"], { stdout: "ignore" })
		await Bun.sleep(1_500)
		expect(proc.exitCode).toBeNull()
		return proc
	})
	expect(await cli.exited).toBe(0)
})
