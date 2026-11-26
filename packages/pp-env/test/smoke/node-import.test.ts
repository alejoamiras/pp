import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../..")

// Dependents load both entries under native Node too, which resolves only specifiers that name a
// real file or a package.json mapping: no tsconfig paths, and no emitted `.js` beside a `.ts`.
// The import goes through a linked dependent, as a workspace's would, not through self-reference.
test("native Node loads both entries with the exports Bun sees", async () => {
	const strips = (await Bun.$`node -p process.features.typescript`.text()).trim()
	expect(["strip", "transform"], "node on PATH must run TypeScript (Node 22.18+ or 23.6+)").toContain(strips)
	const parent = join(homedir(), ".cache/pp/pp-env")
	mkdirSync(parent, { recursive: true })
	const dependent = mkdtempSync(join(parent, "node-dependent-"))
	try {
		mkdirSync(join(dependent, "node_modules/@pp"), { recursive: true })
		symlinkSync(ROOT, join(dependent, "node_modules/@pp/pp-env"))
		for (const entry of ["@pp/pp-env", "@pp/pp-env/client"]) {
			const expected = Object.keys(await import(entry)).sort()
			const list = `console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(entry)})).sort()))`
			const node = Bun.spawn(["node", "--input-type=module", "-e", list], { cwd: dependent, stdout: "pipe", stderr: "pipe" })
			const [code, stdout, stderr] = await Promise.all([
				node.exited,
				new Response(node.stdout).text(),
				new Response(node.stderr).text(),
			])
			expect(code, `${entry}: ${stderr}`).toBe(0)
			expect(JSON.parse(stdout), entry).toEqual(expected)
		}
	} finally {
		rmSync(dependent, { recursive: true, force: true })
	}
}, 60_000)
