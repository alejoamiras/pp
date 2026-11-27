import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { scratchDir } from "../../scripts/proc"
import { fixtureLeaks, stackBuildGuard } from "./plugins"

test("the stack guard flags fixture modules and the fixture marker, and nothing else", () => {
	const fixtures = join("/app", "src", "data", "fixtures")
	const clean = [
		join("/app", "src", "main.tsx"),
		join("/app", "src", "data", "adapters", "index.ts"),
		join("/app", "src", "data", "fixtures-old", "x.ts"),
	]
	expect(fixtureLeaks(clean, [{ fileName: "assets/index.js", text: "const fixtures = 1" }], fixtures)).toEqual([])
	const leaks = fixtureLeaks(
		[...clean, join(fixtures, "index.ts"), `\0${join(fixtures, "connector.ts")}?used`],
		[{ fileName: "assets/index.js", text: "window.__ppFixtures={}" }],
		fixtures,
	)
	expect(leaks).toHaveLength(3)
})

type Hook = ((...args: unknown[]) => unknown) | { handler: (...args: unknown[]) => unknown } | undefined

/** Calls a plugin hook the way the bundler does, with `ctx` as its `this`. */
function run(hook: unknown, ctx: object, ...args: unknown[]): unknown {
	const h = hook as Hook
	if (h === undefined) throw new Error("the plugin has no such hook")
	return (typeof h === "function" ? h : h.handler).apply(ctx, args)
}

test("a stack build fails when a file copied beside the bundle (as from public/) names the fixture marker", () => {
	const dir = scratchDir("guard-output")
	try {
		const html = "<!doctype html>"
		mkdirSync(join(dir, "assets"))
		writeFileSync(join(dir, "index.html"), html)
		writeFileSync(join(dir, "assets", "copied.txt"), "window.__ppFixtures = 1")
		const guard = stackBuildGuard("/app")
		const ctx = {
			getModuleIds: () => [join("/app", "src", "main.tsx")][Symbol.iterator](),
			error: (message: string): never => {
				throw new Error(message)
			},
		}
		run(guard.configResolved, ctx, { root: "/app", build: { outDir: dir }, logger: { info() {} } })
		// The bundle holds only the page; the copied file exists on disk alone, as Vite's public copy leaves it.
		const bundle = { "index.html": { type: "asset", fileName: "index.html", source: html } }
		run(guard.generateBundle, ctx, {}, bundle)
		expect(() => run(guard.writeBundle, ctx, { dir }, bundle)).toThrow("assets/copied.txt names __ppFixtures")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
