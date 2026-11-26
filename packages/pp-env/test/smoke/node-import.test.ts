import { expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Dependents load the stub helpers and the client ABIs under native Node too, which resolves only
// specifiers that name a real file: no Bun or bundler resolution, and no emitted `.js` beside a `.ts`.
test("native Node imports the stub helpers and the client ABIs", async () => {
	const strips = (await Bun.$`node -p process.features.typescript`.text()).trim()
	expect(["strip", "transform"], "node on PATH must run TypeScript (Node 22.18+ or 23.6+)").toContain(strips)
	for (const file of ["src/env/stub.ts", "src/client/abi.ts"]) {
		const url = pathToFileURL(join(import.meta.dir, "../..", file)).href
		const check = `const m = await import(${JSON.stringify(url)}); if (!m.STUB_PROCESSOR_ABI?.length) process.exit(3)`
		const node = Bun.spawn(["node", "--input-type=module", "-e", check], { stdout: "ignore", stderr: "pipe" })
		const [code, stderr] = await Promise.all([node.exited, new Response(node.stderr).text()])
		expect(code, `${file}: ${stderr}`).toBe(0)
	}
})
