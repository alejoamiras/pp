import { defineConfig, devices } from "@playwright/test"
import { runEnv } from "./env"
import { PROFILES } from "./test-wallet/profile"

const env = runEnv()
const here = new URL(".", import.meta.url).pathname
/** The web app under test; `agent.sh` builds it and runs this config only once it exists. */
const appRoot = new URL("../../apps/web/", import.meta.url).pathname

/**
 * One sandbox, one browser, one worker: every spec file owns a context, every test a fresh actor,
 * and parallelism is `--shard` (each shard is its own `agent.sh` run with its own sandbox), split by
 * recorded duration through `shard-reporter.ts`.
 */
export default defineConfig({
	testDir: process.env.PP_E2E_SPECS ?? `${appRoot}e2e`,
	globalSetup: `${here}global-setup.ts`,
	workers: 1,
	fullyParallel: false,
	retries: Number(process.env.PP_E2E_RETRIES ?? 0),
	timeout: 10 * 60_000,
	expect: { timeout: 60_000 },
	reporter: [
		["list"],
		...(process.env.CI ? [["html", { open: "never", outputFolder: `${env.stateDir}/playwright-report` }] as const] : []),
		[`${here}shard-reporter.ts`],
	],
	outputDir: `${env.stateDir}/test-results`,
	use: {
		...devices["Desktop Chrome"],
		baseURL: env.appOrigin,
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		video: "off",
		// The suite never leaves the machine; a slow sandbox block is the only thing worth waiting for.
		actionTimeout: 60_000,
		navigationTimeout: 60_000,
	},
	projects: [{ name: "chromium", use: { channel: undefined } }],
	webServer: [
		{
			// The production-mode local build, served at the exact origin the wallet frames accept.
			command: `bun run --cwd ${appRoot} vite preview --outDir ${env.appDist} --host 127.0.0.1 --port ${env.appPort} --strictPort`,
			url: `${env.appOrigin}/`,
			reuseExistingServer: false,
			timeout: 60_000,
			env: { PP_SANDBOX_ARTIFACTS: env.artifactsDir },
		},
		// The one wallet build, served once per profile so each has its own origin.
		...PROFILES.map((profile) => ({
			command: `bun run --cwd ${here} vite preview --config test-wallet/vite.config.mts --outDir ${env.testWalletDist} --host 127.0.0.1 --port ${new URL(env.testWalletOrigins[profile]).port} --strictPort`,
			url: `${env.testWalletOrigins[profile]}/`,
			reuseExistingServer: false,
			timeout: 60_000,
			env: { PP_SANDBOX_ARTIFACTS: env.artifactsDir, PP_APP_ORIGIN: env.appOrigin },
		})),
	],
})
