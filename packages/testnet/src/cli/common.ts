/**
 * What every testnet CLI shares: argv (the deployment file, then public arguments only), the mode, the
 * guard order, the clients, the run directory a keyed run writes its candidate to, and the exit path.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type ParseArgsConfig, parseArgs } from "node:util"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { createPublicClient, type PublicClient } from "viem"
import { assertForkNode, assertL1Chain, assertNode, assertNoSeed, assertTransport, GuardError, type Mode } from "../guards"
import { redact } from "../redact"
import { parseDeployment, requireSections, type Section, type TestnetDeployment } from "../schema"
import { l1Read, sendRpcOf } from "./wallet"

type Options = NonNullable<ParseArgsConfig["options"]>

export type CliArgs<O extends Options> = {
	file: string
	mode: Mode
	values: ReturnType<typeof parseArgs<{ options: O; allowPositionals: true }>>["values"]
	rest: string[]
}

const MODE_OPTIONS = { rehearse: { type: "string" }, "rehearse-fork": { type: "string" } } as const satisfies Options

/**
 * The deployment file first, then `options`; `--rehearse <manifest>` and `--rehearse-fork <url>` exclude each other.
 * @throws GuardError `argv`
 */
export function cliArgs<O extends Options>(argv: string[], options: O): CliArgs<O> {
	let parsed: ReturnType<typeof parseArgs>
	try {
		parsed = parseArgs({ args: argv, options: { ...options, ...MODE_OPTIONS }, allowPositionals: true, strict: true })
	} catch (e) {
		throw new GuardError("argv", e instanceof Error ? e.message : String(e))
	}
	const [file, ...rest] = parsed.positionals
	if (!file) throw new GuardError("argv", "the deployment file comes first")
	const { rehearse, "rehearse-fork": fork } = parsed.values as { rehearse?: string; "rehearse-fork"?: string }
	if (rehearse !== undefined && fork !== undefined) throw new GuardError("argv", "--rehearse and --rehearse-fork exclude each other")
	const mode: Mode =
		rehearse !== undefined
			? { kind: "rehearse", manifest: rehearse }
			: fork !== undefined
				? { kind: "rehearse-fork", url: fork }
				: { kind: "live" }
	return { file, mode, values: parsed.values as CliArgs<O>["values"], rest }
}

/** @throws Error naming the file and every offending field */
export function loadDeployment(path: string): TestnetDeployment {
	return parseDeployment(JSON.parse(readFileSync(path, "utf8")))
}

/**
 * Clients over the file's endpoints; L1 reads outlast a lagging backend at the public chain's polling
 * interval. CCIP-read is off: a contract the operator controls could otherwise answer a read with an
 * `OffchainLookup` revert and have this process fetch a URL of its choosing.
 */
export function clientsOf(d: TestnetDeployment) {
	const l1 = createPublicClient({
		transport: l1Read(d.network.l1Rpc),
		pollingInterval: PUBLIC_CHAIN_TIMING.pollingIntervalMs,
		ccipRead: false,
	}) as PublicClient
	return { l1, node: () => createAztecNodeClient(d.network.aztecNode) }
}

/**
 * The file's send endpoint serves the mode's chain, as its read endpoint must.
 * @throws GuardError `chain`
 */
export async function assertSendChain(d: TestnetDeployment, mode: Mode): Promise<void> {
	const send = sendRpcOf(d)
	if (send !== d.network.l1Rpc) await assertL1Chain(createPublicClient({ transport: l1Read(send) }), mode)
}

export type Guarded<K extends Section> = {
	d: TestnetDeployment & Required<Pick<TestnetDeployment, K>>
	l1: PublicClient
	node: ReturnType<typeof createAztecNodeClient> | undefined
}

/**
 * The guard order of every keyed CLI but `pause` and `addresses`: the file and `sections` parse, the
 * transport is the mode's, the L1 and its send endpoint serve the mode's chain (mainnet refused by name),
 * on a fork the L1 is the pinned anvil, and, for a CLI that uses L2, the node follows the file's rollup. Keys are read only
 * after this returns.
 * @throws GuardError, or Error from the file's parse
 */
export async function guarded<K extends Section>(file: string, mode: Mode, sections: readonly K[], usesL2: boolean): Promise<Guarded<K>> {
	const d = requireSections(loadDeployment(file), sections)
	assertTransport(d, mode, usesL2)
	const { l1, node } = clientsOf(d)
	await assertL1Chain(l1, mode)
	await assertForkNode(l1, mode)
	await assertSendChain(d, mode)
	if (!usesL2) return { d, l1, node: undefined }
	const n = node()
	await assertNode(n as never, d)
	return { d, l1, node: n }
}

/** Where a keyed run named `run` appends one JSON line per send attempt and answer: hashes, nonces, never a key or raw bytes. */
export const sendLogPath = (d: TestnetDeployment, run: string, mode: Mode): string => join(runDir(d, run, mode), "send-path.jsonl")

/** `~/.cache/pp/testnet/<target>/<run>/`, readable by this user only: a keyed run writes its candidate and forge's logs here, never to the checkout. */
export function runDir(d: TestnetDeployment, run: string, mode: Mode): string {
	const target = mode.kind === "live" ? d.target : `${d.target}-${mode.kind}`
	// A rehearsal keeps its runs under its own root, so a finished rehearsal's journal never reads as
	// a deploy to resume and two rehearsals never share one; a live run ignores it.
	const rehearsalRoot = mode.kind === "live" ? undefined : process.env.PP_TESTNET_RUN_ROOT
	const dir = join(rehearsalRoot || join(homedir(), ".cache", "pp", "testnet"), target, run)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	chmodSync(dir, 0o700)
	return dir
}

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)

/** Writes a candidate section for the agent to validate and promote; `fields` is the allowlist of what it may hold. */
export function writeCandidate(dir: string, section: Section, value: Record<string, unknown>, fields: readonly string[]): string {
	const extra = Object.keys(value).filter((k) => !fields.includes(k))
	if (extra.length) throw new Error(`candidate ${section} carries fields outside its allowlist: ${extra.join(", ")}`)
	const path = join(dir, `candidate-${section}.json`)
	writeFileSync(path, `${JSON.stringify({ [section]: value }, bigints, "\t")}\n`, { mode: 0o600 })
	return path
}

/** One JSON line on stdout, built from `fields` alone: no signature, salt, secret or key ever reaches a report. */
export function report(event: string, fields: Record<string, string | number | bigint | boolean>): void {
	process.stdout.write(`${redact(JSON.stringify({ event, ...fields }, bigints))}\n`)
}

/** One progress line on stderr, scrubbed of every key value this process loaded. */
export function logLine(line: string): void {
	process.stderr.write(`${redact(line)}\n`)
}

/** Runs a CLI body: a guard refusal exits 2 with its reason, any other failure 1, and `body`'s code otherwise. */
export async function main(body: () => Promise<number | undefined>): Promise<never> {
	try {
		assertNoSeed(process.env)
		process.exit((await body()) ?? 0)
	} catch (e) {
		const refused = e instanceof GuardError
		logLine(`${refused ? "refused" : "failed"}: ${e instanceof Error ? e.message : String(e)}`)
		process.exit(refused ? 2 : 1)
	}
}
