import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const EXPORTS = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).exports as Record<string, string>)

// pp-env's entries load this package under native Node, which strips types only: erasable syntax and
// specifiers that name a real file.
test("native Node loads every export through a linked dependent", async () => {
	const parent = join(homedir(), ".cache/pp/run-isolation")
	mkdirSync(parent, { recursive: true })
	const dependent = mkdtempSync(join(parent, "node-dependent-"))
	try {
		mkdirSync(join(dependent, "node_modules/@pp"), { recursive: true })
		symlinkSync(ROOT, join(dependent, "node_modules/@pp/run-isolation"))
		for (const sub of EXPORTS) {
			const entry = `@pp/run-isolation${sub.slice(1)}`
			const node = Bun.spawn(["node", "--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
				cwd: dependent,
				stdout: "ignore",
				stderr: "pipe",
			})
			const [code, stderr] = await Promise.all([node.exited, new Response(node.stderr).text()])
			expect(code, `${entry}: ${stderr}`).toBe(0)
		}
	} finally {
		rmSync(dependent, { recursive: true, force: true })
	}
})
