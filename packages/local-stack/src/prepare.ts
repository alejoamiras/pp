#!/usr/bin/env bun
// `bun run demo:prepare`: the networked, one-time steps a fresh clone needs before `bun run demo`.
// pp-env's fetch builds the pinned pool; the forge build produces the bridge contracts the stack
// deploys from contracts/bridge/evm/out, which is gitignored.
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..", "..")
const EVM = join(ROOT, "contracts", "bridge", "evm")
const FORGE = process.env.FORGE ?? "forge"
/** CI's Foundry; newer releases build these contracts too, but only this one runs the proofs. */
const FORGE_PIN = "1.7.1"
/** The same pins as contracts/bridge/evm/README.md, the bridge-contracts workflow and the bridge-evm-build action. */
const LIBS = [
	["forge-std", "foundry-rs/forge-std@bf647bd6046f2f7da30d0c2bf435e5c76a780c1b"],
	["openzeppelin-contracts", "OpenZeppelin/openzeppelin-contracts@cab19933c33c2ad1d4c7a84864a3601dddfd16f3"],
] as const

function run(cmd: string[], cwd: string): void {
	console.log(`[prepare] ${cmd.join(" ")}`)
	const { exitCode } = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] })
	if (exitCode !== 0) throw new Error(`${cmd[0]} exited with ${exitCode}`)
}

const installed = (dir: string) => existsSync(join(EVM, "lib", dir)) && readdirSync(join(EVM, "lib", dir)).length > 0

run(["bun", "run", "--cwd", "packages/pp-env", "fetch"], ROOT)
const version = Bun.spawnSync([FORGE, "--version"]).stdout.toString()
if (!version.includes(FORGE_PIN)) console.warn(`[prepare] ${FORGE} is not Foundry ${FORGE_PIN}; set FORGE to CI's pin if the build differs`)
const missing = LIBS.filter(([dir]) => !installed(dir)).map(([, pin]) => pin)
if (missing.length) run([FORGE, "install", "--no-git", ...missing], EVM)
run(["bun", "packages/bridge-core/scripts/gen-remappings.ts"], ROOT)
// Tests and scripts are not deployed; skipping them leaves the bytecode unchanged and builds faster.
run([FORGE, "build", "--root", EVM, "--skip", "test", "script"], ROOT)
console.log("[prepare] done: `bun run demo` can boot")
