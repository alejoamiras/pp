import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { scratchDir } from "../../scripts/proc"
import { fixtureLeaks, readOutput } from "./plugins"

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

test("the stack guard scans every written file, so one copied beside the bundle (as from public/) is caught", () => {
	const dir = scratchDir("guard-output")
	try {
		mkdirSync(join(dir, "assets"))
		writeFileSync(join(dir, "index.html"), "<!doctype html>")
		writeFileSync(join(dir, "assets", "copied.txt"), "window.__ppFixtures = 1")
		const files = readOutput(dir)
		expect(files.map((f) => f.fileName).sort()).toEqual(["assets/copied.txt", "index.html"])
		expect(fixtureLeaks([], files, "/app/src/data/fixtures")).toEqual(["assets/copied.txt names __ppFixtures"])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
