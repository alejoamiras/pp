import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

/** A run's paths can hold spaces, quotes and `$`; each must reach the server as one argument. */
const ODD = "/runs/pp state/it's $HOME"
const KIT = fileURLToPath(new URL(".", import.meta.url))
const APP = fileURLToPath(new URL("../../apps/web/", import.meta.url))

/** The words a shell makes of `command`, without running it. */
const words = (command: string) =>
	execFileSync("sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], { encoding: "utf8" })
		.split("\0")
		.slice(0, -1)

test("every web server command hands the run's paths to the shell whole", async () => {
	const base = join(homedir(), ".cache", "pp", "e2e-kit")
	mkdirSync(base, { recursive: true })
	const state = mkdtempSync(join(base, "config-"))
	const saved = { ...process.env }
	try {
		writeFileSync(join(state, "stack.json"), JSON.stringify({ circuitsDir: "/circuits" }))
		Object.assign(process.env, {
			PP_E2E_MODE: "stack",
			PP_SANDBOX_ARTIFACTS: `${ODD}/wallet`,
			PP_APP_PORT: "11",
			PP_TEST_WALLET_PORT_PLAIN: "12",
			PP_TEST_WALLET_PORT_FULL: "13",
			PP_APP_DIST: `${ODD}/app-dist`,
			PP_TEST_WALLET_DIST: `${ODD}/wallet-dist`,
			PP_E2E_STATE_DIR: state,
		})
		const { default: config } = await import("./playwright.config")
		const [app, ...wallets] = [config.webServer ?? []].flat().map((s) => words(s.command))
		const host = (port: string) => ["--host", "127.0.0.1", "--port", port, "--strictPort"]
		expect(app).toEqual(["bun", "run", "--cwd", APP, "serve", "--outDir", `${ODD}/app-dist`, ...host("11")])
		expect(wallets).toEqual(
			["12", "13"].map((port) => [
				...["bun", "run", "--cwd", KIT, "vite", "preview", "--config", "test-wallet/vite.config.mts"],
				...["--outDir", `${ODD}/wallet-dist`, ...host(port)],
			]),
		)
	} finally {
		process.env = saved
		rmSync(state, { recursive: true, force: true })
	}
})
