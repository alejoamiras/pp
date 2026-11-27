/**
 * The owner's session for a stack build, loaded on first sign-in: it carries the pool client, the
 * bridge client and snarkjs, which a page that never signs in does not download. The derivation
 * signature goes straight into `openBridgeSession` and is never kept; the bridge session holds the
 * keys derived from it.
 *
 * Each proof is kept with the frozen attempt it was made under and spent once, only under that
 * attempt. A spend goes out through the guarded Ethereum client pinned to its attempt, and a claim
 * through the Aztec wallet of the connection it is bound to. The journal lives in the page's storage
 * under this app's own prefix, so `forget` can delete it without the session's keys.
 */
import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import {
	type BridgeClient,
	type BridgeReceipt,
	type BridgeSession,
	type BridgeRecordView as CoreRecordView,
	createBridgeClient,
	isBridgeClientError,
	type KeyValueStore,
	openBridgeSession,
	type PreflightWallet,
	type PreparedBridgeSpend,
	parseStackManifest,
	prepareBridgeSpend,
	type SubmitOptions,
} from "@pp/bridge-core"
import { type ArtifactSource, secretDerivationTypedData, workerProver } from "@pp/pool-client"
import { createArtifacts } from "@pp/pool-client/circuits"
import { type Hash, type PublicClient, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem"
import type { StackManifestJson } from "../../build/target"
import { BridgeFailure, ProviderError } from "../errors"
import { parseAztecAddress } from "../parse"
import type { Attempt, L1TxState, Proved, Session, SessionPort, SubmitHooks, Timer } from "../ports"
import type { AztecAddress, BridgeRecordView } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { type AztecDeps, boundTo, grantedPayload, sendThroughWallet } from "./aztec"
import { PROVED_CIRCUIT } from "./circuit"
import type { StackL1 } from "./l1"
import { type DelegatingProver, delegatingProver } from "./prover"

/** Every journal key this app writes starts with this; nothing else in the page's storage does. */
export const JOURNAL_PREFIX = "pp.web.bridge."

export type PageStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

export interface SessionDeps {
	/** As the build inlined it; parsed again here with the schema the build parsed it with. */
	manifest: StackManifestJson
	reads: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">
	prover: DelegatingProver
	/** Where pool-client fetches the pinned proving files: the page's own server. */
	artifacts: ArtifactSource
	l1: Pick<StackL1, "spendWallet">
	aztec: AztecDeps
	storage: PageStorage
	/** Tests pass their own three; otherwise bridge-core's, with one client over the manifest and the journal. */
	open?: typeof openBridgeSession
	prepare?: typeof prepareBridgeSpend
	client?: BridgeClient
}

/** bridge-core's journal store, inside the app's prefix. */
export function journalStore(storage: PageStorage): KeyValueStore {
	return {
		getItem: (k) => storage.getItem(JOURNAL_PREFIX + k),
		setItem: (k, v) => storage.setItem(JOURNAL_PREFIX + k, v),
		removeItem: (k) => storage.removeItem(JOURNAL_PREFIX + k),
	}
}

function forgetJournal(storage: PageStorage): void {
	const keys: string[] = []
	for (let i = 0; i < storage.length; i++) {
		const k = storage.key(i)
		if (k?.startsWith(JOURNAL_PREFIX)) keys.push(k)
	}
	for (const k of keys) storage.removeItem(k)
}

/** `null` for viem's not-found error, which is an answer here; anything else is an RPC failure. */
const unlessMissing = (err: unknown): null => {
	if (err instanceof TransactionReceiptNotFoundError || err instanceof TransactionNotFoundError) return null
	throw err
}

export async function l1TxState(reads: SessionDeps["reads"], hash: Hash): Promise<L1TxState> {
	const receipt = await reads.getTransactionReceipt({ hash }).catch(unlessMissing)
	if (receipt) return receipt.status === "success" ? "mined" : "reverted"
	return (await reads.getTransaction({ hash }).catch(unlessMissing)) ? "pending" : "unknown"
}

const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

function appAddress(value: unknown): AztecAddress {
	const parsed = parseAztecAddress(value)
	if (parsed === null) throw new BridgeFailure("RPC_INCONSISTENT")
	return parsed
}

const appView = (v: CoreRecordView): BridgeRecordView => ({ ...v, recipient: appAddress(v.recipient) })

/**
 * The calls preflight makes, on connection `epoch`'s wallet while it stays live, with a simulation
 * only of functions the grant allows for simulation. The bridge client keeps this object for the
 * send's last check, so a replaced connection fails that check instead of answering from its wallet.
 */
export function preflightWallet(d: Pick<AztecDeps, "current">, epoch: number): PreflightWallet {
	const live = (): HeldWallet => boundTo(d, epoch)
	return {
		getChainInfo: async () => live().wallet.getChainInfo(),
		getAccounts: async () => live().wallet.getAccounts(),
		async simulateTx(exec, opts) {
			const held = live()
			if (!grantedPayload(held, "simulation.transactions", exec)) throw new BridgeFailure("NOT_GRANTED")
			return held.wallet.simulateTx(exec, opts)
		},
	}
}

/** bridge-core reports the wallet's no before broadcast as `RPC_FAILED`; the driver reads it as the wallet's refusal. */
function asPageError(err: unknown): unknown {
	if (isBridgeClientError(err) && err.code === "RPC_FAILED" && err.source === "UserRejectedRequestError")
		return new ProviderError(4001, "The wallet declined the request.")
	return err
}

interface Known {
	receipt: BridgeReceipt
	recipient: AztecAddress
}

interface Ctx {
	s: BridgeSession
	deps: SessionDeps
	client: BridgeClient
	portal: `0x${string}`
	known: Map<string, Known>
	proofs: WeakMap<Proved, { spend: PreparedBridgeSpend; attempt: Attempt }>
}

async function records(c: Ctx): Promise<BridgeRecordView[]> {
	const views = (await c.client.records(c.s)).map(appView)
	for (const v of views) if (v.receipt) c.known.set(v.id, { receipt: v.receipt, recipient: v.recipient })
	return views
}

async function recover(c: Ctx, recipient: AztecAddress): Promise<BridgeRecordView[]> {
	return (await c.client.recover(c.s, sdk(recipient))).map(({ id, ...receipt }) => {
		c.known.set(id, { receipt, recipient })
		const { nullifier, amount, l1TxHash } = receipt
		return { id, nullifier, recipient, amount, l1TxHash, step: "mined", receipt }
	})
}

/** The record a receipt belongs to: the journal names it, and the chain does when the journal could not. */
async function viewOf(c: Ctx, receipt: BridgeReceipt, recipient: AztecAddress): Promise<BridgeRecordView> {
	const mine = (v: BridgeRecordView) => v.nullifier === receipt.nullifier
	const found = (await records(c)).find(mine) ?? (await recover(c, recipient)).find(mine)
	if (!found) throw new BridgeFailure("RPC_INCONSISTENT")
	return found
}

async function knownOrRead(c: Ctx, id: string): Promise<Known> {
	const k = c.known.get(id) ?? (await records(c).then(() => c.known.get(id)))
	if (!k) throw new BridgeFailure("NOT_CLAIMABLE")
	return k
}

async function prove(c: Ctx, a: Attempt): Promise<Proved> {
	const recipient = sdk(a.recipient)
	const spend = await (c.deps.prepare ?? prepareBridgeSpend)(c.s, { note: a.note, amount: a.amount, portal: c.portal, recipient })
	const proved = Object.freeze({ note: a.note, label: spend.change.label, amount: spend.amount, change: spend.change.value }) as Proved
	c.proofs.set(proved, { spend, attempt: a })
	return proved
}

/** Refuses a proof made under another attempt, or spent already, before anything reaches the bridge client. */
async function submit(c: Ctx, p: Proved, a: Attempt, on: SubmitHooks, o?: { acceptUncertain?: true }): Promise<BridgeRecordView> {
	const bound = c.proofs.get(p)
	c.proofs.delete(p)
	if (bound?.attempt !== a) throw new BridgeFailure("SPEND_MISMATCH")
	const wallet = c.deps.l1.spendWallet(a, on.handoff, on)
	const options: SubmitOptions = { onReprove: (code) => on.reproving(code), ...(o?.acceptUncertain ? { acceptUncertain: true } : {}) }
	const receipt = await c.client.submit(bound.spend, wallet, c.s, options).catch((err: unknown) => {
		throw asPageError(err)
	})
	return viewOf(c, receipt, a.recipient)
}

function stackSession(c: Ctx): Session {
	const { s, deps } = c
	let open = true
	const live = () => {
		if (!open) throw new BridgeFailure("SESSION_CLOSED")
	}
	return {
		owner: s.l1Address,
		notes: () => s.pool.notes(),
		nullifierOf: (commitment) => s.pool.nullifierOf(commitment),
		async preflight(recipient, epoch) {
			live()
			await c.client.preflight({ recipient: sdk(recipient), wallet: preflightWallet(deps.aztec, epoch) })
		},
		warmUp: () => warmUp(deps.artifacts),
		async prove(a) {
			live()
			return prove(c, a)
		},
		cancelProve: () => deps.prover.cancel(),
		async submit(p, a, on, o) {
			live()
			return submit(c, p, a, on, o)
		},
		async waitClaimable(id, signal) {
			await c.client.waitClaimable((await knownOrRead(c, id)).receipt, { signal })
		},
		async claim(id, on) {
			live()
			const { receipt, recipient } = await knownOrRead(c, id)
			const payload = await c.client.claimPayload(s, receipt)
			return sendThroughWallet(deps.aztec, {
				epoch: on.epoch,
				from: recipient,
				payload,
				contracts: ["hub", "token"],
				handoff: on.handoff,
			})
		},
		records: () => records(c),
		recover: (recipient) => recover(c, recipient),
		l1TxState: (hash) => l1TxState(deps.reads, hash),
		close() {
			open = false
			c.proofs = new WeakMap()
			c.known.clear()
		},
	}
}

let warm: Promise<void> | undefined

/** Fetches and checks the proved circuit's files once per page, so the first proof does not wait on them. */
function warmUp(artifacts: ArtifactSource): Promise<void> {
	warm ??= (async () => {
		await createArtifacts(artifacts).ensure(PROVED_CIRCUIT)
	})().catch((err: unknown) => {
		warm = undefined
		throw err
	})
	return warm
}

export function stackSessions(deps: SessionDeps): SessionPort {
	const open = deps.open ?? openBridgeSession
	const manifest = parseStackManifest(deps.manifest)
	const bridge = manifest.bridge
	if (!bridge) throw new BridgeFailure("DEPLOYMENT_MISMATCH")
	const client = deps.client ?? createBridgeClient({ manifest, journal: journalStore(deps.storage) })
	return {
		async open({ owner, sign }) {
			const signature = await sign(secretDerivationTypedData(owner))
			const s = await open({ manifest, l1Address: owner, signature, artifacts: deps.artifacts, prover: deps.prover })
			return stackSession({ s, deps, client, portal: bridge.portal, known: new Map(), proofs: new WeakMap() })
		},
		// A mined bridge stays recoverable from the signature and the chain; an unmined record goes with the journal.
		forget: async () => forgetJournal(deps.storage),
	}
}

let pageProver: DelegatingProver | undefined

/** The page's one prover; its worker starts on the first proof. */
export function proverFor(timer: Timer): DelegatingProver {
	pageProver ??= delegatingProver(
		() => workerProver(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" })),
		timer,
	)
	return pageProver
}
