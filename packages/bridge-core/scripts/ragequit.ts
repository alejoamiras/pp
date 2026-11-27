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
 * `PP_AZTEC_SECRET` is the account's sandbox secret and `PP_L1_KEY` the settling Ethereum key: test
 * keys, read only after the manifest passes, never printed. The payee defaults to `PP_L1_KEY`'s address.
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type Address, createWalletClient, getAddress, type Hex, http, isAddress, type WalletClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { labelledTokenArtifact } from "../src/artifacts"
import { type BridgeClient, createBridgeClient } from "../src/client/bridge-client"
import { ragequitChunks } from "../src/client/chunks"
import { BridgeClientError } from "../src/client/errors"
import type { ExitTicket } from "../src/client/types"
import { parseStackManifest, requireBlocks } from "../src/stack-manifest"
import { account, device, memoryJournal, send } from "./stack-actors"

const LOCAL_CHAIN_ID = 31337
/** `private_notes_by_label` returns at most this many values per call (`VALUES_PER_PAGE`). */
const VALUES_PER_PAGE = 10
const POLL_MS = 2_000
const READY_TIMEOUT_MS = 10 * 60_000
const KEY = /^0x[0-9a-fA-F]{64}$/
const INTEGER = /^(0x[0-9a-fA-F]+|[0-9]+)$/

/** A refusal before anything is read from a chain or a key: bad arguments, environment or manifest. */
export class UsageError extends Error {}

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

/** The keys this mode needs, checked by shape; a message names the variable, never its value. */
export function keysFrom(env: Record<string, string | undefined>, settleOnly: boolean): { l1: Hex; aztec?: Hex } {
	const key = (name: string): Hex => {
		const v = env[name]
		if (!v || !KEY.test(v)) throw new UsageError(`${name} must hold a 32-byte hex key`)
		return v as Hex
	}
	return settleOnly ? { l1: key("PP_L1_KEY") } : { l1: key("PP_L1_KEY"), aztec: key("PP_AZTEC_SECRET") }
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
	send: (payload: Awaited<ReturnType<BridgeClient["ragequitPayload"]>>) => Promise<string>
	stop(): Promise<void>
}

/** The account `secret` derives, on a fresh device that knows the SponsoredFPC, the hub and its token. */
async function holderOf(m: ReturnType<typeof localManifest>, secret: Hex): Promise<Holder> {
	const d = await device(m)
	try {
		const { address } = await account(d, secret)
		const token = await Contract.at(d.token, labelledTokenArtifact, d.wallet as never)
		return { address, token, send: async (payload) => (await send(d, address, payload)).txHash.toString(), stop: d.stop }
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

const describe = (t: ExitTicket) => `${t.kind} of ${t.amount} to ${t.payee} (L2 tx ${t.l2TxHash}, message ${t.messageIndexInTx})`

export async function untilReady(client: BridgeClient, t: ExitTicket): Promise<void> {
	const end = Date.now() + READY_TIMEOUT_MS
	while ((await client.exitStatus(t)) === "proving") {
		if (Date.now() > end) throw new Error(`no Outbox root covered the ${describe(t)} within ${READY_TIMEOUT_MS / 60_000} min`)
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

async function run(a: RagequitArgs, m: ReturnType<typeof localManifest>, keys: { l1: Hex; aztec?: Hex }, log: (s: string) => void) {
	const client = createBridgeClient({ manifest: m, journal: memoryJournal() })
	const account = privateKeyToAccount(keys.l1)
	const chain = { ...foundry, rpcUrls: { default: { http: [m.l1Rpc] } } }
	const l1 = createWalletClient({ account, chain, transport: http(m.l1Rpc) })
	const payee = a.payee ?? account.address
	if (a.settleOnly || !keys.aztec) return settleAll(client, l1, await client.exitTickets({ payee }), log)
	const holder = await holderOf(m, keys.aztec)
	try {
		const label = a.label ?? (await onlyLabel(holder))
		const burned = await burnLabel(
			{
				notes: () => notesOf(holder, label),
				pause: () => new Promise((r) => setTimeout(r, POLL_MS)),
				burn: async (amount) => {
					const tx = await holder.send(await client.ragequitPayload({ payee, amount, label }))
					log(`burned ${amount} under the label in L2 tx ${tx}`)
					return tx
				},
			},
			a.amount,
		)
		const mine = new Set(burned.map((h) => h.toLowerCase()))
		const tickets = (await client.exitTickets({ payee })).filter((t) => mine.has(t.l2TxHash.toLowerCase()))
		for (const t of tickets) log(`ticket: ${describe(t)}`)
		await settleAll(client, l1, tickets, log)
	} finally {
		await holder.stop()
	}
}

/** Exit codes: 0 done, 1 a chain or client failure, 2 a usage, environment or manifest refusal. */
export async function main(argv: string[], env: Record<string, string | undefined>, log = console.log): Promise<number> {
	let ready: [RagequitArgs, ReturnType<typeof localManifest>, { l1: Hex; aztec?: Hex }]
	try {
		const a = parseRagequitArgs(argv)
		const m = localManifest(env.PP_STACK_MANIFEST)
		ready = [a, m, keysFrom(env, a.settleOnly)]
	} catch (e) {
		console.error(`ragequit: ${e instanceof Error ? e.message : "refused"}`)
		return 2
	}
	try {
		await run(...ready, log)
		return 0
	} catch (e) {
		const why =
			e instanceof BridgeClientError
				? `${e.code}${e.source ? ` (${e.source})` : ""}`
				: ((e instanceof Error ? e.message : "").split("\n")[0] ?? "failed")
		console.error(`ragequit: ${why}`)
		return e instanceof UsageError ? 2 : 1
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env))
