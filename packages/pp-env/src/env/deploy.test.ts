import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PublicClient } from "viem"
import type { Checkout } from "./checkout.ts"
import { deployPool } from "./deploy.ts"

const KEY = `0x${"11".repeat(32)}` as const
const DEPLOYER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"

let dir: string
let co: Checkout
let prevForge: string | undefined
// A forge that logs each subcommand and whether PRIVATE_KEY reached it; `build` compiles when `stale` exists.
beforeAll(async () => {
	const parent = join(homedir(), ".cache/pp/pp-env")
	await mkdir(parent, { recursive: true })
	dir = await mkdtemp(join(parent, "deploy-test-"))
	const forge = join(dir, "forge")
	await writeFile(
		forge,
		`#!/usr/bin/env bash
echo "$1 key=\${PRIVATE_KEY:+set}" >> '${dir}/forge.log'
case "$1" in
	config) echo '{"ffi":false}' ;;
	build) if [ -e '${dir}/stale' ]; then echo "Compiling 3 files with Solc 0.8.32"; fi ;;
	script) case " $* " in *" --skip-simulation "*) echo skip-simulation >> '${dir}/forge.log' ;; esac ;;
esac
`,
		{ mode: 0o755 },
	)
	const contracts = join(dir, "contracts")
	await mkdir(join(contracts, "cache"), { recursive: true })
	await writeFile(join(contracts, "cache/solidity-files-cache.json"), "{}")
	co = { src: dir, contracts, circuits: dir, target: dir }
	prevForge = process.env.PP_FORGE
	process.env.PP_FORGE = forge
})
afterEach(() => rm(join(dir, "forge.log"), { force: true }))
afterAll(async () => {
	if (prevForge === undefined) delete process.env.PP_FORGE
	else process.env.PP_FORGE = prevForge
	await rm(dir, { recursive: true, force: true })
})

const deploy = (checkBuild: () => void, skipSimulation?: boolean) =>
	deployPool({
		rpcUrl: "http://127.0.0.1:1",
		co,
		deployerKey: KEY,
		deployer: DEPLOYER,
		workDir: join(dir, "run"),
		client: {} as PublicClient,
		checkBuild,
		skipSimulation,
	})
const calls = async () => (await readFile(join(dir, "forge.log"), "utf8")).trim().split("\n")

test("a failed build check stops the deploy before the key reaches forge", async () => {
	await expect(
		deploy(() => {
			throw new Error("pins differ")
		}),
	).rejects.toThrow("pins differ")
	expect(await calls()).toEqual(["config key=", "build key="])
})

test("a keyless build that recompiles stops the deploy before the check and the key", async () => {
	await writeFile(join(dir, "stale"), "")
	let checked = false
	try {
		await expect(
			deploy(() => {
				checked = true
			}),
		).rejects.toThrow("forge recompiled the pool before the deploy")
	} finally {
		await rm(join(dir, "stale"))
	}
	expect([checked, await calls()]).toEqual([false, ["config key=", "build key="]])
})

test.each([
	[true, ["config key=", "build key=", "script key=set", "skip-simulation"]],
	[false, ["config key=", "build key=", "script key=set"]],
])("the keyed script leaves forge's own gas replay out only when asked (%p)", async (skip, want) => {
	// The fake script prints no deployment, so the deploy fails after it ran.
	await expect(deploy(() => {}, skip)).rejects.toThrow()
	expect(await calls()).toEqual(want)
})
