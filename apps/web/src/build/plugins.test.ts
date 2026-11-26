import { join } from "node:path"
import { expect, test } from "vitest"
import { fixtureLeaks } from "./plugins"

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
