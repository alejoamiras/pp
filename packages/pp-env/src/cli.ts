#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { startPoolEnv } from "./env/index.ts"

const USAGE = "usage: pp-env up [--rpc <loopback anvil url>] [--deployer-index <n>]"

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: { rpc: { type: "string" }, "deployer-index": { type: "string" }, help: { type: "boolean", short: "h" } },
})
if (values.help || positionals.length !== 1 || positionals[0] !== "up") {
	console.error(USAGE)
	process.exit(values.help ? 0 : 2)
}
const index = values["deployer-index"]
if (index !== undefined && !/^\d+$/.test(index)) {
	console.error(`--deployer-index must be a non-negative integer\n${USAGE}`)
	process.exit(2)
}

const t0 = performance.now()
const env = await startPoolEnv({ rpcUrl: values.rpc, deployerIndex: index === undefined ? undefined : Number(index) })
const { stop: _stop, deployStub: _deployStub, asp, ...rest } = env
const out = { ...rest, aspUrl: asp.url, startMs: Math.round(performance.now() - t0) }
console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), "\t"))
console.error("[pp-env] up; Ctrl-C stops it")
// The servers already hold the loop open; this keeps the CLI alive in attach mode too.
setInterval(() => {}, 1 << 30)
