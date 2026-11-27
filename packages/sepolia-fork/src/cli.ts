#!/usr/bin/env bun
// `run [--require-rpc] [--prepare-only]`: the fork suite; --prepare-only stops after the fixture. `pins <block>`:
// every binding as read at <block>, for a pin refresh.
// The endpoint comes only from SEPOLIA_RPC_URL; unset, `run` skips unless --require-rpc makes that a failure.
import { PINS } from "./pins.ts"
import { PreflightError, readBindings } from "./preflight.ts"
import { ENDPOINT_RETRIES, hostOf, httpRpc, scrub } from "./rpc.ts"

/** Read once, then removed, so nothing this process starts inherits it. */
function takeEndpoint(): string | undefined {
	const url = process.env.SEPOLIA_RPC_URL || undefined
	delete process.env.SEPOLIA_RPC_URL
	return url
}

async function pins(endpoint: string, block: string | undefined): Promise<void> {
	if (!block || !/^\d+$/.test(block)) throw new Error("usage: pins <block number>")
	const rpc = httpRpc(endpoint, { retries: ENDPOINT_RETRIES })
	const header = await rpc<{ hash: string }>("eth_getBlockByNumber", [`0x${BigInt(block).toString(16)}`, false])
	const bindings = await readBindings(rpc, PINS, BigInt(block))
	console.log(
		JSON.stringify({ block: { number: block, hash: header.hash }, bindings }, (_, v) => (typeof v === "bigint" ? `${v}n` : v), 2),
	)
}

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv
	const endpoint = takeEndpoint()
	if (command !== "run" && command !== "pins") {
		console.error("usage: cli.ts run [--require-rpc] [--prepare-only] | pins <block>")
		return 2
	}
	if (!endpoint) {
		if (command === "run" && !rest.includes("--require-rpc")) {
			console.log("sepolia-fork: skipped: SEPOLIA_RPC_URL is unset (a public Sepolia endpoint with archive state)")
			return 0
		}
		console.error("sepolia-fork: SEPOLIA_RPC_URL is unset")
		return 1
	}
	const protocol = URL.parse(endpoint)?.protocol
	if (protocol !== "https:" && protocol !== "http:") {
		console.error("sepolia-fork: SEPOLIA_RPC_URL is not an http(s) URL")
		return 1
	}
	try {
		if (command === "pins") await pins(endpoint, rest[0])
		else {
			// Loaded only for a real run: the pool SDK takes seconds to import, and the skip line should not.
			const [{ runFork }, { prepare }, { runForkCases }] = await Promise.all([
				import("./run.ts"),
				import("./prepare.ts"),
				import("./forge.ts"),
			])
			await runFork({
				endpoint,
				body: async (fork, run) => {
					const { fixture, path } = await prepare(fork, run)
					if (rest.includes("--prepare-only")) return
					const { dataDir, cleanup } = run
					const passed = await runForkCases({
						url: fork.url,
						block: fixture.block,
						fixture: path,
						dataDir,
						cleanup,
						signal: run.signal,
					})
					run.log(`${passed} fork cases passed`)
				},
			})
		}
		return 0
	} catch (err) {
		const kind = err instanceof PreflightError ? `${err.kind} ` : ""
		console.error(scrub(`sepolia-fork: ${kind}failure: ${err instanceof Error ? err.message : String(err)}`, [endpoint]))
		console.error(`sepolia-fork: endpoint host ${hostOf(endpoint)}`)
		return 1
	}
}

// exit, not exitCode: work abandoned at the deadline must not hold the process open after teardown.
process.exit(await main(process.argv.slice(2)))
