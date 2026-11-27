import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { type Address, createPublicClient, type Hash, http, type WalletClient } from "viem"
import type { StackManifest } from "../stack-manifest"
import { guarded, translate } from "./boundary"
import { abortable, type ClaimNode, claimPayload, type WaitClaimableOptions, waitClaimable } from "./claim"
import { type ClientDeployment, type DeploymentNode, type DeploymentReader, namedDeployment, verifyDeployment } from "./deployment"
import { exitPublicPayload } from "./exit-public"
import { exitStatusOf, exitState } from "./exits"
import { type ExitContext, type ExitNode, type ExitReader, exitReads, exitTickets, ragequitPayload, settle } from "./exits-chain"
import type { KeyValueStore } from "./journal"
import { laggingTolerant } from "./lagging"
import { type PreflightNode, type PreflightWallet, Preflights, preflight } from "./preflight"
import { prepareBridgeSpend } from "./prepare"
import { type RecordsContext, records, recover } from "./records"
import type { BridgeSession } from "./session"
import { type SubmitContext, type SubmitOptions, type SubmitReader, submit } from "./submit"
import { type ClientTiming, clientTiming, LOCAL_TIMING } from "./timing"
import type { BridgeReceipt, BridgeRecordView, ExitStatus, ExitTicket, PreparedBridgeSpend } from "./types"

/**
 * One bridge generation's client. Every method first awaits a one-time check that the manifest's
 * RPC and node agree with its deployment (`CHAIN_MISMATCH`, `DEPLOYMENT_MISMATCH`). No option takes a
 * fee or payment method: every L2 transaction it builds pays through the SponsoredFPC.
 */
export interface BridgeClient {
	/**
	 * Checks that `recipient` can claim and binds it to `wallet` on this client for ten minutes.
	 * @throws BridgeClientError `RECIPIENT_INVALID`, `CHAIN_MISMATCH`, `RECIPIENT_NOT_IN_WALLET`, `FEE_PATH_FAILED`
	 */
	preflight(a: { recipient: AztecAddress; wallet: PreflightWallet }): Promise<void>
	/** Sends a checked bridge spend; see `submit` for the checks, the journal and the outcome codes. */
	submit(spend: PreparedBridgeSpend, l1: WalletClient, s: BridgeSession, o?: SubmitOptions): Promise<BridgeReceipt>
	/** Resolves once the bridge's message can be consumed on L2. */
	waitClaimable(r: BridgeReceipt, o?: WaitClaimableOptions): Promise<void>
	/** The hub's `claim_from_pool` call for `r`, paid by the SponsoredFPC, for the recipient's wallet to send. */
	claimPayload(s: BridgeSession, r: BridgeReceipt): Promise<ExecutionPayload>
	/** `recipient`'s unclaimed bridges of the session's notes, from chain data alone. */
	recover(s: BridgeSession, recipient: AztecAddress): Promise<(BridgeReceipt & { id: string })[]>
	/** The session's journal records, pending ones included, each with its step read from the chain. */
	records(s: BridgeSession): Promise<BridgeRecordView[]>
	/**
	 * The hub's `ragequit` of `amount` under `label` to `payee`, paid by the SponsoredFPC, for the
	 * holder's wallet to send. Burn exact chunks only (`ragequitChunks`). `a` is read once, at the call.
	 * @throws BridgeClientError `SPEND_MISMATCH` naming the refused field in `source`
	 */
	ragequitPayload(a: { payee: Address; amount: bigint; label: bigint }): Promise<ExecutionPayload>
	/**
	 * The hub's `exit_public` of `amount` of the sender's public balance of the deployment's token to
	 * `payee`. `a` is read once, at the call.
	 * @throws BridgeClientError `SPEND_MISMATCH` naming the refused field in `source`
	 */
	exitPublicPayload(a: { payee: Address; amount: bigint }): Promise<ExecutionPayload>
	/** The deployment token's ragequit and public exit tickets from L2 block `fromBlock` on, from chain data alone. */
	exitTickets(a: { payee?: Address; fromBlock?: bigint }): Promise<ExitTicket[]>
	/** `proving` until an Outbox root covers the ticket, then `ready`, then `settled` once the portal paid its exact leaf. */
	exitStatus(t: ExitTicket): Promise<ExitStatus>
	/** Settles `t` on Ethereum from `l1`, or returns the transaction that already did. */
	settle(t: ExitTicket, l1: WalletClient): Promise<Hash>
}

export type ClientIo = {
	reader: SubmitReader & DeploymentReader & ExitReader
	node: ClaimNode & PreflightNode & DeploymentNode & ExitNode
	store: KeyValueStore
}

/**
 * A client for the bridge `manifest` names, over its L1 RPC and Aztec node, keeping bridge records in
 * `journal` (sealed; the app passes `localStorage`). Builds no connection and reads nothing until a
 * method is called. `timing` (default {@link LOCAL_TIMING}) bounds the submit and settle receipt
 * waits, past which a sent transaction is reported `UNCERTAIN` and never sent again by itself, and
 * sets the L1 polling interval; it is copied here.
 * @throws RangeError when a `timing` value is not a positive finite number
 * @throws BridgeClientError `DEPLOYMENT_MISMATCH` when the manifest carries no bridge
 */
export function createBridgeClient(a: { manifest: StackManifest; journal: KeyValueStore; timing?: ClientTiming }): BridgeClient {
	const timing = clientTiming(a.timing)
	try {
		return bridgeClientOver(a.manifest, clientIo(a.manifest, a.journal, timing), { timing })
	} catch (e) {
		throw translate(e)
	}
}

/** The L1 reader polls at `timing`'s interval, and its block-naming reads outlast a lagging backend. */
export function clientIo(manifest: StackManifest, store: KeyValueStore, timing: ClientTiming = LOCAL_TIMING): ClientIo {
	const reader = createPublicClient({
		transport: laggingTolerant(http(manifest.l1Rpc), timing.pollingIntervalMs),
		pollingInterval: timing.pollingIntervalMs,
	})
	return { reader, node: createAztecNodeClient(manifest.aztecNode), store }
}

/**
 * `createBridgeClient` over given IO. The manifest's fields are copied here; later changes to it are
 * ignored. Tests pass a short `timing` when a send must end before its transaction mines.
 * @throws RangeError when a `timing` value is not a positive finite number
 */
export function bridgeClientOver(manifest: StackManifest, io: ClientIo, o: { timing?: ClientTiming } = {}): BridgeClient {
	const timing = clientTiming(o.timing)
	const named = namedDeployment(manifest)
	const { reader, node, store } = io
	const preflights = new Preflights()
	let verified: Promise<ClientDeployment> | undefined
	// Kept once it passes; a failed check, a transient read included, runs again on the next call.
	const deployment = () => {
		verified ??= verifyDeployment(reader, node, named).catch((e: unknown) => {
			verified = undefined
			throw e
		})
		return verified
	}
	const { receiptTimeoutMs } = timing
	const submitContext = async (): Promise<SubmitContext> => ({
		deployment: await deployment(),
		reader,
		store,
		preflights,
		reprove: (s, spend) =>
			prepareBridgeSpend(s, { note: spend.spentCommitment, amount: spend.amount, portal: named.portal, recipient: spend.recipient }),
		receiptTimeoutMs,
	})
	const recordsContext = async (): Promise<RecordsContext> => ({ deployment: await deployment(), reader, node, store })
	const exitContext = async (): Promise<ExitContext> => ({ deployment: await deployment(), reader, node, timing })
	const exits = <T>(f: (c: ExitContext) => Promise<T>) => guarded(async () => f(await exitContext()))
	// `read` takes the request's fields by name at the call, before anything awaits: an app that
	// reuses a mutable form object would otherwise get a payload other than the one its user
	// confirmed. Named reads, not a spread, so a getter-backed form keeps working; a read that throws
	// still rejects as the client's error.
	const payload = <A>(read: () => A, build: (d: ClientDeployment, a: A) => Promise<ExecutionPayload>): Promise<ExecutionPayload> => {
		let asCalled: A
		try {
			asCalled = read()
		} catch (e) {
			return Promise.reject(translate(e))
		}
		return guarded(async () => build((await exitContext()).deployment, asCalled))
	}
	return Object.freeze({
		preflight: async (a) => preflight({ deployment: await deployment(), node, preflights }, a),
		submit: (spend, l1, s, o) => submit(submitContext, spend, l1, s, o),
		waitClaimable: async (r, o) => {
			await abortable(deployment(), o?.signal).catch((e: unknown) => {
				throw translate(e)
			})
			return waitClaimable(node, r, o)
		},
		claimPayload: async (s, r) => claimPayload(await deployment(), s, r),
		recover: async (s, recipient) => recover(await recordsContext(), s, recipient),
		records: async (s) => records(await recordsContext(), s),
		ragequitPayload: (a) => payload(() => ({ payee: a.payee, amount: a.amount, label: a.label }), ragequitPayload),
		exitPublicPayload: (a) => payload(() => ({ payee: a.payee, amount: a.amount }), exitPublicPayload),
		exitTickets: (a) => exits((c) => exitTickets(c, a)),
		exitStatus: (t) => exits(async (c) => exitStatusOf(await exitState(exitReads(c), t))),
		settle: (t, l1) => exits((c) => settle(c, t, l1)),
	} satisfies BridgeClient)
}
