/**
 * One run's coordinates, resolved by `scripts/e2e/agent.sh` and read here by the config, the global
 * setup and the fixtures. Nothing boots in-process: the network is the CLI's (the sandbox's, or the
 * local stack's in stack mode), the servers are Playwright's `webServer`s over builds the runner
 * produced.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Address } from "viem"
import { PROFILES, type TestWalletProfile } from "./test-wallet/profile"

/** `sandbox`: the bridge sandbox and a fixture-world app build; `stack`: the local stack and an app built against its manifest. */
export type E2eMode = "sandbox" | "stack"

export interface RunEnv {
	mode: E2eMode
	/** The `handle.json` the test wallet builds from: `sandbox:up`'s, or the one `stack.ts up` writes. */
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

/** What `scripts/e2e/stack.ts up` records in `<state>/stack.json`: anvil indices, never keys. */
export interface StackRun {
	pgid: number
	manifestPath: string
	/** The pool checkout's circuit builds, as the stack's CLI printed them; the app's server serves these. */
	circuitsDir: string
	accounts: { user: { address: Address; index: number }; sender: { address: Address; index: number } }
}

function required(name: string): string {
	const v = process.env[name]
	if (!v) throw new Error(`browser suite: ${name} is not set — run it through scripts/e2e/agent.sh`)
	return v
}

function modeOf(value: string | undefined): E2eMode {
	if (value === undefined || value === "" || value === "sandbox") return "sandbox"
	if (value === "stack") return "stack"
	throw new Error(`browser suite: PP_E2E_MODE is ${value}; use sandbox or stack`)
}

export function runEnv(): RunEnv {
	const artifactsDir = required("PP_SANDBOX_ARTIFACTS")
	const appPort = Number(required("PP_APP_PORT"))
	const walletPort = (p: TestWalletProfile) => Number(required(`PP_TEST_WALLET_PORT_${p.toUpperCase()}`))
	return {
		mode: modeOf(process.env.PP_E2E_MODE),
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

export const stackRunFile = (env: Pick<RunEnv, "stateDir">): string => join(env.stateDir, "stack.json")

/** The stack this run booted or attached to; throws outside stack mode's state. */
export function stackRun(env: Pick<RunEnv, "stateDir">): StackRun {
	return JSON.parse(readFileSync(stackRunFile(env), "utf8")) as StackRun
}

/** The wallet URLs the app's local build lists, one per profile — the strings baked into its bundle. */
export function webWalletUrls(env: Pick<RunEnv, "testWalletOrigins">): string[] {
	return PROFILES.map((p) => `${env.testWalletOrigins[p]}/?profile=${p}`)
}
