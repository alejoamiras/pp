import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"))
const root = read("package.json")

const workspaces: string[] = root.workspaces
	.flatMap((pattern: string) => [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })])
	.map((manifest: string) => read(manifest).name)
	.sort()

// Each workspace's vitest pool sizes itself to the machine's cores, so two pools at once on a 4-core
// runner push jsdom tests past their timeouts; without `--no-exit-on-error` one failure skips the rest.
// `--filter` passes over a workspace without the script, so every workspace must declare one.
test("test:all runs every workspace's test script, one workspace at a time", () => {
	expect(root.scripts["test:all"]).toBe(
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run --filter '@pp/*' --sequential --no-exit-on-error test",
	)
	for (const pattern of root.workspaces as string[])
		for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })) {
			const script = read(manifest).scripts?.test
			expect(typeof script === "string" && script.trim() !== "", `${manifest} declares a test script`).toBe(true)
		}
})

// `bun run --filter` passes over a workspace its pattern misses without a word.
test("the all-workspace scripts select every workspace", () => {
	expect(workspaces).toEqual([
		"@pp/asp-bot",
		"@pp/bridge-core",
		"@pp/bridge-spec",
		"@pp/e2e-kit",
		"@pp/label-paths",
		"@pp/labelled-token",
		"@pp/local-stack",
		"@pp/pool-client",
		"@pp/pp-env",
		"@pp/run-isolation",
		"@pp/sepolia-fork",
		"@pp/testnet",
		"@pp/web",
	])
	for (const script of ["typecheck:all", "test:all"]) {
		const filter = root.scripts[script].match(/--filter '([^']+)'/)?.[1]
		expect(filter, script).toBeDefined()
		const glob = new Bun.Glob(filter)
		expect(
			workspaces.filter((name) => glob.match(name)),
			script,
		).toEqual(workspaces)
	}
})
