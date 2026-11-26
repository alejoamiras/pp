#!/usr/bin/env bun
// Typechecks a throwaway dependent of @pp/pp-env that resolves it through package.json "exports",
// with no path aliases, no Bun types and no `.ts` imports allowed: what a workspace package sees,
// and proof that the public types need no pool checkout.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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

export async function use(): Promise<bigint> {
	const env: PoolEnv = await startPoolEnv({ signals: false })
	const chain: 31337 = CHAIN_ID
	// @ts-expect-error the env is typed precisely, not any
	env.chainId = 1
	const config: ClientConfig = env.clientConfig
	const user = await createPoolUser(config, { wallet: undefined as never })
	const spend: PreparedSpend = await user.prepareSpend({ processor: env.asset, data: "0x", asset: env.asset, amountOut: 1n })
	const [proof] = spend.args
	// @ts-expect-error pubSignals rows are bigint arrays
	const wrong: string = proof.pubSignals[0]
	void [chain, wrong, STUB_PROCESSOR_ABI.length, TRANSACT_ABI.length, secretDerivationTypedData(env.asset).primaryType]
	return spend.nullifier
}
`

const TSCONFIG = {
	compilerOptions: {
		target: "ESNext",
		module: "ESNext",
		moduleResolution: "Bundler",
		lib: ["ESNext"],
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	},
	include: ["consumer.ts"],
}

const parent = join(homedir(), ".cache/pp/pp-env")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "consumer-"))
try {
	mkdirSync(join(dir, "node_modules/@pp"), { recursive: true })
	symlinkSync(PACKAGE_DIR, join(dir, "node_modules/@pp/pp-env"))
	await Bun.write(join(dir, "consumer.ts"), CONSUMER)
	await Bun.write(join(dir, "tsconfig.json"), JSON.stringify(TSCONFIG))
	const tsc = Bun.resolveSync("typescript/bin/tsc", PACKAGE_DIR)
	const proc = Bun.spawn(["bun", tsc, "-p", dir], { stdio: ["ignore", "inherit", "inherit"] })
	const code = await proc.exited
	if (code !== 0) console.error("a dependent cannot typecheck against @pp/pp-env's public types")
	process.exit(code)
} finally {
	rmSync(dir, { recursive: true, force: true })
}
