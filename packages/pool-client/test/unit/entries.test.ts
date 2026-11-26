import { execFileSync } from "node:child_process"
import { build } from "vite"
import { expect, it } from "vitest"
import { PACKAGE_DIR } from "../support/paths.ts"

// Vitest transforms every module, so neither failure below shows up in the other suites.

it.skipIf("Bun" in globalThis)("loads the package entry by name in native Node", () => {
	const out = execFileSync(
		"node",
		["--input-type=module", "-e", 'console.log(typeof (await import("@pp/pool-client")).openPoolClient)'],
		{
			cwd: PACKAGE_DIR,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		},
	)
	expect(out.trim()).toBe("function")
})

it("refuses the testing subpath in a browser build", async () => {
	const entry = "\0entry.js"
	const bundle = build({
		root: PACKAGE_DIR,
		configFile: false,
		logLevel: "silent",
		build: { write: false, rollupOptions: { input: entry } },
		plugins: [
			{
				name: "entry",
				resolveId: (id) => (id === entry ? id : null),
				load: (id) => (id === entry ? 'import "@pp/pool-client/testing"' : null),
			},
		],
	})
	await expect(bundle).rejects.toThrow(/testing/)
})
