/**
 * One run's coordinates, resolved by `scripts/e2e/agent.sh` and read here by the config, the global
 * setup and the fixtures. Nothing boots in-process: the sandbox is the CLI's, the servers are
 * Playwright's `webServer`s over builds the runner produced.
 */
import { join } from "node:path"
import { PROFILES, type TestWalletProfile } from "./test-wallet/profile"

export interface RunEnv {
	/** `handle.json` and `manifest.json`, written by `sandbox:up`. */
	artifactsDir: string
	appPort: number
	appDist: string
	appOrigin: string
	testWalletDist: string
	/** One loopback origin per profile — the SDK's discovery probe tells wallet frames apart by
	 *  origin alone, so same-origin profiles would answer each other's probe. */
	testWalletOrigins: Record<TestWalletProfile, string>
	/** Where a run keeps its own state (ports, owned pids, traces). */
	stateDir: string
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`browser suite: ${name} is not set — run it through scripts/e2e/agent.sh`)
	return v
}

export function runEnv(): RunEnv {
	const artifactsDir = required("PP_SANDBOX_ARTIFACTS")
	const appPort = Number(required("PP_APP_PORT"))
	const walletPort = (p: TestWalletProfile) => Number(required(`PP_TEST_WALLET_PORT_${p.toUpperCase()}`))
	return {
		artifactsDir,
		appPort,
		appDist: required("PP_APP_DIST"),
		appOrigin: `http://127.0.0.1:${appPort}`,
		testWalletDist: required("PP_TEST_WALLET_DIST"),
		testWalletOrigins: Object.fromEntries(PROFILES.map((p) => [p, `http://127.0.0.1:${walletPort(p)}`])) as Record<
			TestWalletProfile,
			string
		>,
		stateDir: process.env.PP_E2E_STATE_DIR ?? join(artifactsDir, ".."),
	}
}

/** The wallet URLs the app's local build lists, one per profile — the strings baked into its bundle. */
export function webWalletUrls(env: Pick<RunEnv, "testWalletOrigins">): string[] {
	return PROFILES.map((p) => `${env.testWalletOrigins[p]}/?profile=${p}`)
}
