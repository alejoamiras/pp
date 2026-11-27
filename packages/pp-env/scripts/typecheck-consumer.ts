#!/usr/bin/env bun
// Typechecks a throwaway dependent of @pp/pp-env that resolves it through package.json "exports",
// with no path aliases, no Bun types and no `.ts` imports allowed: what a workspace package sees,
// and proof that the public types need no pool checkout. Declarations are checked too, so one that
// names an SDK type fails even when nothing uses it; viem's own typings need the DOM lib.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { PACKAGE_DIR } from "../src/env/checkout.ts"

const CONSUMER = `import {
	CHAIN_ID,
	createPoolUser,
	type PoolEnv,
	type PreparedSpend,
	startPoolEnv,
	STUB_PROCESSOR_ABI,
	TRANSACT_ABI,
} from "@pp/pp-env"
import { type ClientConfig, secretDerivationTypedData } from "@pp/pp-env/client"
import { attachForkPoolEnv, type ForkPoolEnv } from "@pp/pp-env/fork"
import { deployPoolOn, type MockAsp, startMockAsp, type SepoliaPool, verifyPoolCode } from "@pp/pp-env/sepolia"

export async function use(): Promise<bigint> {
	const env: PoolEnv = await startPoolEnv({ signals: false })
	const chain: 31337 = CHAIN_ID
	// @ts-expect-error the env is typed precisely, not any
	env.chainId = 1
	const config: ClientConfig = env.clientConfig
	const fork: ForkPoolEnv = await attachForkPoolEnv({ ...config, clientVersion: "anvil/v1.7.1", postman: env.asset, runId: "r" })
	// @ts-expect-error only the pinned bundle names are accepted
	const bundle: ClientConfig["circuitBundle"] = "mainnet"
	const user = await createPoolUser(config, { wallet: undefined as never })
	const spend: PreparedSpend = await user.prepareSpend({ processor: env.asset, data: "0x", asset: env.asset, amountOut: 1n })
	const [proof] = spend.args
	// @ts-expect-error pubSignals rows are bigint arrays
	const wrong: string = proof.pubSignals[0]
	const pool: SepoliaPool = await deployPoolOn({ rpcUrl: "", chainId: 11155111, deployerKey: "0x", mint: { to: env.asset, amount: 1n }, runDir: "" })
	// @ts-expect-error only Sepolia is accepted
	await deployPoolOn({ rpcUrl: "", chainId: 1, deployerKey: "0x", mint: { to: env.asset, amount: 1n }, runDir: "" })
	const asp: MockAsp = await startMockAsp({ rpcUrl: "", chainId: 11155111, postmanKey: "0x", deployment: pool.deployment, port: 1, owner: env.asset })
	const checked = await verifyPoolCode({ rpcUrl: "", chainId: 11155111, deployment: pool.deployment })
	void [checked.length, asp.approved(), fork.clientConfig.circuitBundle, bundle, chain, wrong, STUB_PROCESSOR_ABI.length, TRANSACT_ABI.length, secretDerivationTypedData(env.asset).primaryType]
	return spend.nullifier
}
`

const TSCONFIG = {
	compilerOptions: {
		target: "ESNext",
		module: "ESNext",
		moduleResolution: "Bundler",
		lib: ["ESNext", "DOM"],
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
	},
	include: ["consumer.ts"],
}

const parent = join(homedir(), ".cache/pp/pp-env")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "consumer-"))
try {
	// A copy of what the package publishes, so nothing resolves into `.ppv2` or other local state.
	const view = join(dir, "node_modules/@pp/pp-env")
	for (const part of ["package.json", "types", "src"]) cpSync(join(PACKAGE_DIR, part), join(view, part), { recursive: true })
	symlinkSync(realpathSync(dirname(Bun.resolveSync("viem/package.json", PACKAGE_DIR))), join(dir, "node_modules/viem"))
	await Bun.write(join(dir, "consumer.ts"), CONSUMER)
	await Bun.write(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG))
	const tsc = Bun.resolveSync("typescript/bin/tsc", PACKAGE_DIR)
	const proc = Bun.spawn(["bun", tsc, "-p", dir], { stdio: ["ignore", "inherit", "inherit"] })
	process.exitCode = await proc.exited
	if (process.exitCode !== 0) console.error("a dependent cannot typecheck against @pp/pp-env's public types")
} finally {
	rmSync(dir, { recursive: true, force: true })
}
