/**
 * `bun run ragequit`: exits a label's private balance to Ethereum on the local stack that
 * `PP_STACK_MANIFEST` names, from keys alone. It burns exact chunks through the hub, each paid by the
 * SponsoredFPC, waits for each ticket's Outbox root on chain state and settles it. `--settle-only`
 * settles a payee's unsettled tickets from chain data with `PP_L1_KEY` alone. It opens no pool client
 * and never calls the ASP.
 *
 *   bun run ragequit [--amount <n>] [--label <n>] [--payee <address>]
 *   bun run ragequit --settle-only --payee <address>
 *
 * `PP_AZTEC_SECRET` is the account's secret and `PP_L1_KEY` the settling Ethereum key: read only after
 * the manifest and the live RPC and node show chain 31337, never printed. The payee defaults to
 * `PP_L1_KEY`'s address. Chain 31337 bounds where the secret is used, not what it is worth elsewhere, so
 * its wallet store is a real-key one: in a tmpfs `/dev/shm`, never on disk, and the CLI refuses to burn
 * on a host without one.
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type Address, createPublicClient, createWalletClient, getAddress, type Hex, http, isAddress, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { labelledTokenArtifact } from "../src/artifacts"
import { type BridgeClient, createBridgeClient } from "../src/client/bridge-client"
import { ragequitChunks } from "../src/client/chunks"
import { BridgeClientError } from "../src/client/errors"
import type { ExitTicket } from "../src/client/types"
import { parseStackManifest, requireBlocks } from "../src/stack-manifest"
import { createNode } from "./script-bootstrap"
import { account, device, memoryJournal, send } from "./stack-actors"
import { storeRoot } from "./wallet-store"

const LOCAL_CHAIN_ID = 31337
/** `private_notes_by_label` returns at most this many values per call (`VALUES_PER_PAGE`). */
const VALUES_PER_PAGE = 10
const POLL_MS = 2_000
const READY_TIMEOUT_MS = 10 * 60_000
/** Ticket reads after the burns before a burn without its ticket counts as a failure. */
const TICKET_READS = 15
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const KEY = /^0x[0-9a-fA-F]{64}$/
const INTEGER = /^(0x[0-9a-fA-F]+|[0-9]+)$/

/** A refusal before anything is read from a chain or a key: bad arguments, environment or manifest. */
export class UsageError extends Error {}

/** A failure the CLI words itself, from public values only. */
class RagequitError extends Error {}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export type RagequitArgs = { settleOnly: boolean; amount?: bigint; label?: bigint; payee?: Address }

function positive(flag: string, v: string | undefined): bigint | undefined {
	if (v === undefined) return undefined
	if (!INTEGER.test(v) || BigInt(v) === 0n) throw new UsageError(`${flag} takes a positive integer`)
	return BigInt(v)
}

export function parseRagequitArgs(argv: string[]): RagequitArgs {
	let parsed: ReturnType<typeof parseFlags>
	try {
		parsed = parseFlags(argv)
	} catch (e) {
		throw new UsageError(e instanceof Error ? e.message : "unreadable arguments")
	}
	const { values, positionals } = parsed
	if (positionals.length) throw new UsageError(`unexpected argument: ${positionals[0]}`)
	if (values.payee !== undefined && !isAddress(values.payee)) throw new UsageError("--payee takes an Ethereum address")
	const payee = values.payee === undefined ? undefined : getAddress(values.payee)
	const settleOnly = values["settle-only"] ?? false
	if (settleOnly && (!payee || values.amount !== undefined || values.label !== undefined))
		throw new UsageError("--settle-only takes --payee and nothing else")
	return { settleOnly, payee, amount: positive("--amount", values.amount), label: positive("--label", values.label) }
}

const parseFlags = (argv: string[]) =>
	parseArgs({
		args: argv,
		allowPositionals: true,
		options: { amount: { type: "string" }, label: { type: "string" }, payee: { type: "string" }, "settle-only": { type: "boolean" } },
	})

/** The manifest at `path`, refused unless it is the local chain's and carries a bridge; its schema refuses non-loopback URLs there. */
export function localManifest(path: string | undefined) {
	if (!path) throw new UsageError("PP_STACK_MANIFEST is not set: start a stack with `bun run demo --keep`")
	const m = parseStackManifest(JSON.parse(readFileSync(path, "utf8")))
	if (m.chainId !== LOCAL_CHAIN_ID) throw new UsageError(`ragequit runs on the local chain ${LOCAL_CHAIN_ID} only, not ${m.chainId}`)
	return requireBlocks(m, ["bridge"])
}

type Manifest = ReturnType<typeof localManifest>
type Keys = { l1: Hex; aztec?: Hex }

/**
 * The keys this mode needs, checked by shape and by range: the libraries that take them put an
 * out-of-range value in their error messages. A message names the variable, never its value.
 */
export function keysFrom(env: Record<string, string | undefined>, settleOnly: boolean): Keys {
	const key = (name: string, below: bigint): Hex => {
		const v = env[name]
		if (!v || !KEY.test(v) || BigInt(v) === 0n || BigInt(v) >= below) throw new UsageError(`${name} must hold a valid 32-byte hex key`)
		return v as Hex
	}
	const l1 = key("PP_L1_KEY", SECP256K1_ORDER)
	return settleOnly ? { l1 } : { l1, aztec: key("PP_AZTEC_SECRET", Fr.MODULUS) }
}

/** The L1 chain ids the manifest's RPC and its Aztec node report. */
export type ChainProbe = (m: Manifest) => Promise<readonly number[]>

const liveChains: ChainProbe = async (m) => {
	const [l1, info] = await Promise.all([
		createPublicClient({ transport: http(m.l1Rpc) }).getChainId(),
		createNode(m.aztecNode).getNodeInfo(),
	])
	return [l1, info.l1ChainId]
}

type Burn = { tx: string; amount: bigint }

/** Each burn's one ticket, or the burns that show none yet. */
function matchBurns(all: readonly ExitTicket[], burns: readonly Burn[], label: bigint): ExitTicket[] | RagequitError {
	const found = burns.map((b) => all.filter((t) => t.l2TxHash.toLowerCase() === b.tx.toLowerCase()))
	const exact = (ts: ExitTicket[], b: Burn) =>
		ts.length === 1 && ts[0]?.kind === "ragequit" && ts[0].amount === b.amount && ts[0].label === label
	if (burns.some((b, j) => found[j]?.length && !exact(found[j], b))) throw new BridgeClientError("RPC_INCONSISTENT")
	const missing = burns.filter((_, j) => !found[j]?.length).map((b) => b.tx)
	return missing.length ? new RagequitError(`no ticket shows for L2 tx ${missing.join(", ")}`) : found.map((ts) => ts[0] as ExitTicket)
}

/**
 * Each burn's ticket, once every burn shows exactly one of its amount and label. The node can index a
 * burn's logs after its receipt and a read can fail in passing, so both are read again within `reads`.
 * @throws BridgeClientError `RPC_INCONSISTENT` at once when a burn shows another ticket than it made;
 * otherwise the last read's failure, or the burns still without a ticket, after `reads`
 */
export async function ticketsOfBurns(
	read: () => Promise<ExitTicket[]>,
	burns: readonly Burn[],
	label: bigint,
	pause: () => Promise<void>,
	reads = TICKET_READS,
): Promise<ExitTicket[]> {
	for (let i = 1; ; i++) {
		const outcome = await read().then(
			(all) => matchBurns(all, burns, label),
			(e: unknown) => e,
		)
		if (Array.isArray(outcome)) return outcome
		if (i >= reads) throw outcome
		await pause()
	}
}

export type BurnIo = {
	notes(): Promise<bigint[]>
	burn(amount: bigint): Promise<string>
	/** Waits before a re-read that does not yet show the last burn. */
	pause(): Promise<void>
}

/** Reads after a confirmed burn before its absence from the notes counts as an inconsistency. */
const BURN_READS = 5

const total = (vs: readonly bigint[]) => vs.reduce((s, v) => s + v, 0n)

/**
 * Burns exact chunks until `amount` has left, or the whole balance without one. The notes are
 * re-read before every burn, so a balance over one page finishes and a selection that took other
 * notes is seen; the first read checks the whole amount, so an inexact one burns nothing.
 * @returns each burn's L2 transaction hash, in order
 * @throws BridgeClientError `NOTE_NOT_FOUND` when the label holds nothing; `NO_EXACT_CHUNKS`;
 * `RPC_INCONSISTENT` when a confirmed burn does not show in the notes read after it
 */
export async function burnLabel(io: BurnIo, amount?: bigint): Promise<string[]> {
	const txs: string[] = []
	let left = amount
	let notes = await io.notes()
	if (!notes.length) throw new BridgeClientError("NOTE_NOT_FOUND")
	while (left !== 0n && notes.length) {
		const chunk = ragequitChunks(notes, left)[0] as bigint
		txs.push(await io.burn(chunk))
		if (left !== undefined) left -= chunk
		notes = await afterBurn(io, total(notes) - chunk)
	}
	if (left) throw new BridgeClientError("NO_EXACT_CHUNKS")
	return txs
}

/** The notes once they show a burn, as their total says; the wallet's sync can trail the block. */
async function afterBurn(io: BurnIo, expected: bigint): Promise<bigint[]> {
	for (let i = 0; i < BURN_READS; i++) {
		if (i) await io.pause()
		const notes = await io.notes()
		if (total(notes) === expected) return notes
	}
	throw new BridgeClientError("RPC_INCONSISTENT")
}

/** A utility function's `BoundedVec` result as its rows. */
function rowsOf<T>(r: unknown): T[] {
	const v = ((r as { result?: unknown }).result ?? r) as { storage?: T[]; len?: bigint | number } | T[]
	return Array.isArray(v) ? v : (v.storage ?? []).slice(0, Number(v.len ?? 0))
}

type Holder = {
	address: AztecAddress
	token: Contract
	/** The burn's L2 transaction hash and, once the node reports it, its block. */
	send: (payload: Awaited<ReturnType<BridgeClient["ragequitPayload"]>>) => Promise<{ tx: string; block?: bigint }>
	stop(): Promise<void>
}

/** The account `secret` derives, on a fresh device that knows the SponsoredFPC, the hub and its token. */
async function holderOf(m: Manifest, secret: Hex): Promise<Holder> {
	const d = await device(m, { sandboxKeysOnly: false })
	try {
		const { address } = await account(d, secret)
		const token = await Contract.at(d.token, labelledTokenArtifact, d.wallet as never)
		const sendBurn = async (payload: Parameters<Holder["send"]>[0]) => {
			const r = await send(d, address, payload)
			return { tx: r.txHash.toString(), block: r.blockNumber === undefined ? undefined : BigInt(r.blockNumber) }
		}
		return { address, token, send: sendBurn, stop: d.stop }
	} catch (e) {
		await d.stop()
		throw e
	}
}

async function onlyLabel(h: Holder): Promise<bigint> {
	const rows = rowsOf<[bigint, bigint, bigint]>(
		await h.token.methods.private_balances_by_label(h.address, 0).simulate({ from: h.address } as never),
	)
	const labels = [...new Set(rows.filter(([, , v]) => BigInt(v) > 0n).map(([l]) => BigInt(l)))]
	if (labels.length !== 1) throw new UsageError(`the account holds ${labels.length} labels with a balance: name one with --label`)
	return labels[0] as bigint
}

async function notesOf(h: Holder, label: bigint): Promise<bigint[]> {
	const out: bigint[] = []
	for (let start = 0; ; start += VALUES_PER_PAGE) {
		const page = rowsOf<bigint>(
			await h.token.methods.private_notes_by_label(h.address, label, start).simulate({ from: h.address } as never),
		)
		out.push(...page.map((v) => BigInt(v)))
		if (page.length < VALUES_PER_PAGE) return out
	}
}

const pause = () => new Promise<void>((r) => setTimeout(r, POLL_MS))

const describe = (t: ExitTicket) => `${t.kind} of ${t.amount} to ${t.payee} (L2 tx ${t.l2TxHash}, message ${t.messageIndexInTx})`

export async function untilReady(client: BridgeClient, t: ExitTicket): Promise<void> {
	const end = Date.now() + READY_TIMEOUT_MS
	while ((await client.exitStatus(t)) === "proving") {
		if (Date.now() > end) throw new RagequitError(`no Outbox root covered the ${describe(t)} within ${READY_TIMEOUT_MS / 60_000} min`)
		await new Promise((r) => setTimeout(r, POLL_MS))
	}
}

async function settleAll(client: BridgeClient, l1: WalletClient, tickets: ExitTicket[], log: (s: string) => void): Promise<void> {
	for (const t of tickets) {
		if ((await client.exitStatus(t)) === "settled") {
			log(`already settled: ${describe(t)}`)
			continue
		}
		await untilReady(client, t)
		log(`settled ${describe(t)} in L1 tx ${await client.settle(t, l1)}`)
	}
}

async function run(a: RagequitArgs, m: Manifest, keys: Keys, log: (s: string) => void) {
	const client = createBridgeClient({ manifest: m, journal: memoryJournal() })
	const account = privateKeyToAccount(keys.l1)
	const chain = { ...foundry, rpcUrls: { default: { http: [m.l1Rpc] } } }
	const l1 = createWalletClient({ account, chain, transport: http(m.l1Rpc) })
	const payee = a.payee ?? account.address
	if (a.settleOnly || !keys.aztec) return settleAll(client, l1, await client.exitTickets({ payee }), log)
	const holder = await holderOf(m, keys.aztec)
	try {
		const label = a.label ?? (await onlyLabel(holder))
		const burns: (Burn & { block?: bigint })[] = []
		await burnLabel(
			{
				notes: () => notesOf(holder, label),
				pause,
				burn: async (amount) => {
					const { tx, block } = await holder.send(await client.ragequitPayload({ payee, amount, label }))
					log(`burned ${amount} under the label in L2 tx ${tx}`)
					burns.push({ tx, amount, block })
					return tx
				},
			},
			a.amount,
		)
		// From the first burn's block, so the payee's older tickets are neither read nor indexed.
		const blocks = burns.map((b) => b.block)
		const fromBlock = blocks.every((b) => b !== undefined) ? blocks.reduce((x, y) => (y < x ? y : x)) : undefined
		const tickets = await ticketsOfBurns(() => client.exitTickets({ payee, fromBlock }), burns, label, pause)
		for (const t of tickets) log(`ticket: ${describe(t)}`)
		await settleAll(client, l1, tickets, log)
	} finally {
		await holder.stop()
	}
}

/** Refuses before any key is read where the secret's wallet store could not stay off disk. */
function realKeyStore(): void {
	try {
		storeRoot({ sandboxKeysOnly: false })
	} catch {
		throw new UsageError("burning needs a tmpfs /dev/shm to keep PP_AZTEC_SECRET's wallet store off disk")
	}
}

/**
 * What a failure prints. The client's codes (with an uncertain settle's L1 hash) and the CLI's own
 * words carry public values only. Once keys are loaded (`raw` false), a lower layer's message never
 * prints, only its error's name: a library can put its input in its message.
 */
export function reason(e: unknown, raw: boolean): string {
	if (e instanceof BridgeClientError)
		return [e.code, e.source && `(${e.source})`, e.l1TxHash && `in L1 tx ${e.l1TxHash}`].filter(Boolean).join(" ")
	if (e instanceof UsageError || e instanceof RagequitError) return e.message
	if (raw && e instanceof Error && e.message) return e.message.split("\n")[0] as string
	return e instanceof Error && IDENTIFIER.test(e.name) ? e.name : "failed"
}

function fail(e: unknown, raw: boolean, code = e instanceof UsageError ? 2 : 1): number {
	console.error(`ragequit: ${reason(e, raw)}`)
	return code
}

/**
 * Exit codes: 0 done, 1 a chain or client failure, 2 a usage, environment or manifest refusal. The
 * live chain check runs before any key is read.
 */
export async function main(argv: string[], env: Record<string, string | undefined>, log = console.log, chains = liveChains) {
	let a: RagequitArgs
	let m: Manifest
	try {
		a = parseRagequitArgs(argv)
		m = localManifest(env.PP_STACK_MANIFEST)
	} catch (e) {
		return fail(e, true, 2)
	}
	let keys: Keys
	try {
		if ((await chains(m)).some((id) => id !== LOCAL_CHAIN_ID))
			throw new UsageError(`the manifest's RPC or node is not on the local chain ${LOCAL_CHAIN_ID}`)
		if (!a.settleOnly) realKeyStore()
		keys = keysFrom(env, a.settleOnly)
	} catch (e) {
		return fail(e, true)
	}
	try {
		await run(a, m, keys, log)
		return 0
	} catch (e) {
		return fail(e, false)
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env))
