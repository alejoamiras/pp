#!/usr/bin/env bun
// `run` is the fork suite, which --prepare-only stops after the fixture; `pins` prints every binding at <block>
// for a pin refresh. The endpoint comes only from SEPOLIA_RPC_URL; unset, `run` skips unless --require-rpc
// makes that a failure. Usage errors never echo an argument, which may be a mistyped endpoint.
import { parseArgs } from "node:util"
import { DEFAULT_TARGET, isTargetName, type Pins, TARGETS } from "./pins.ts"
import { enroll, PreflightError } from "./preflight.ts"
import { ENDPOINT_RETRIES, hostOf, httpRpc, scrub } from "./rpc.ts"

const USAGE = "usage: cli.ts run [--target <name>] [--require-rpc] [--prepare-only] | pins <block> [--target <name>]"

/** Read once, then removed, so nothing this process starts inherits it. */
function takeEndpoint(): string | undefined {
	const url = process.env.SEPOLIA_RPC_URL || undefined
	delete process.env.SEPOLIA_RPC_URL
	return url
}

type Command = { command: "run"; pins: Pins; requireRpc: boolean; prepareOnly: boolean } | { command: "pins"; pins: Pins; block: bigint }

const OPTIONS = {
	target: { type: "string" },
	"require-rpc": { type: "boolean" },
	"prepare-only": { type: "boolean" },
} as const

/** parseArgs quotes the offending token, which may be an endpoint; these say what is wrong without it. */
const PARSE_ERRORS: Record<string, string> = {
	ERR_PARSE_ARGS_UNKNOWN_OPTION: "unknown option",
	ERR_PARSE_ARGS_INVALID_OPTION_VALUE: "an option's value is missing or not allowed",
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>["values"]

function command(pins: Pins, name: string | undefined, rest: string[], values: Values): Command | string {
	if (name === "run") {
		if (rest.length > 0) return "run takes no arguments"
		return { command: name, pins, requireRpc: values["require-rpc"] === true, prepareOnly: values["prepare-only"] === true }
	}
	if (name === "pins") {
		if (values["require-rpc"] !== undefined || values["prepare-only"] !== undefined) return "pins takes only --target"
		const [block, ...extra] = rest
		if (block === undefined || extra.length > 0 || !/^\d+$/.test(block)) return "pins takes one block number"
		return { command: name, pins, block: BigInt(block) }
	}
	return "the command is run or pins"
}

/** The command line, or the reason it is not one; checked before the endpoint, so a typo never reads as a skip. */
function parse(argv: string[]): Command | string {
	try {
		const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
		const target = values.target ?? DEFAULT_TARGET
		if (!isTargetName(target)) return `unknown target; known: ${Object.keys(TARGETS).join(", ")}`
		const [name, ...rest] = positionals
		return command(TARGETS[target], name, rest, values)
	} catch (err) {
		return PARSE_ERRORS[String((err as { code?: unknown }).code)] ?? "unreadable command line"
	}
}

async function printPins(endpoint: string, pins: Pins, block: bigint): Promise<void> {
	const rpc = httpRpc(endpoint, { retries: ENDPOINT_RETRIES })
	const pin = await enroll(rpc, pins, block)
	console.log(
		JSON.stringify(
			{ block: { number: String(block), hash: pin.block.hash }, bindings: pin.bindings },
			(_, v) => (typeof v === "bigint" ? `${v}n` : v),
			2,
		),
	)
}

async function run(endpoint: string, c: Extract<Command, { command: "run" }>): Promise<void> {
	// Loaded only for a real run, so the skip line stays instant.
	const { runFork } = await import("./run.ts")
	await runFork({
		endpoint,
		pins: c.pins,
		body: async (fork, ctx) => {
			// Only past the preflight: pp-env's pool code resolves into the fetched pool checkout, which a run
			// that fails earlier must not need.
			const [{ prepare }, { runForkCases }] = await Promise.all([import("./prepare.ts"), import("./forge.ts")])
			const { fixture, path } = await prepare(fork, ctx)
			if (c.prepareOnly) return
			const { dataDir, cleanup } = ctx
			const passed = await runForkCases({ url: fork.url, block: fixture.block, fixture: path, dataDir, cleanup, signal: ctx.signal })
			ctx.log(`${passed} fork cases passed`)
		},
	})
}

async function main(argv: string[]): Promise<number> {
	const endpoint = takeEndpoint()
	const c = parse(argv)
	if (typeof c === "string") {
		console.error(`sepolia-fork: ${c}`)
		console.error(USAGE)
		return 2
	}
	if (!endpoint) {
		if (c.command === "run" && !c.requireRpc) {
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
		if (c.command === "pins") await printPins(endpoint, c.pins, c.block)
		else await run(endpoint, c)
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
