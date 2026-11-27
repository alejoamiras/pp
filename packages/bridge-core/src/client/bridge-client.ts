import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { createPublicClient, http, type WalletClient } from "viem"
import type { StackManifest } from "../stack-manifest"
import { translate } from "./boundary"
import { type ClaimNode, claimPayload, type WaitClaimableOptions, waitClaimable } from "./claim"
import { type ClientDeployment, type DeploymentNode, type DeploymentReader, namedDeployment, verifyDeployment } from "./deployment"
import type { KeyValueStore } from "./journal"
import { type PreflightNode, type PreflightWallet, Preflights, preflight } from "./preflight"
import { prepareBridgeSpend } from "./prepare"
import { type RecordsContext, records, recover } from "./records"
import type { BridgeSession } from "./session"
import { type SubmitContext, type SubmitOptions, type SubmitReader, submit } from "./submit"
import type { BridgeReceipt, BridgeRecordView, PreparedBridgeSpend } from "./types"

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
}

export type ClientIo = {
	reader: SubmitReader & DeploymentReader
	node: ClaimNode & PreflightNode & DeploymentNode
	store: KeyValueStore
}

/** Past this a sent bridge with no receipt is reported `UNCERTAIN`, never sent again by itself. */
const RECEIPT_TIMEOUT_MS = 120_000

/**
 * A client for the bridge `manifest` names, over its L1 RPC and Aztec node, keeping bridge records in
 * `journal` (sealed; the app passes `localStorage`). Builds no connection and reads nothing until a
 * method is called.
 * @throws BridgeClientError `DEPLOYMENT_MISMATCH` when the manifest carries no bridge
 */
export function createBridgeClient(a: { manifest: StackManifest; journal: KeyValueStore }): BridgeClient {
	try {
		return bridgeClientOver(a.manifest, clientIo(a.manifest, a.journal))
	} catch (e) {
		throw translate(e)
	}
}

export function clientIo(manifest: StackManifest, store: KeyValueStore): ClientIo {
	const reader = createPublicClient({ transport: http(manifest.l1Rpc), pollingInterval: 1_000 })
	return { reader, node: createAztecNodeClient(manifest.aztecNode), store }
}

/**
 * `createBridgeClient` over given IO. The manifest's fields are copied here; later changes to it are
 * ignored. `receiptTimeoutMs` is for tests that need a send to end before its transaction mines.
 */
export function bridgeClientOver(manifest: StackManifest, io: ClientIo, o: { receiptTimeoutMs?: number } = {}): BridgeClient {
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
	const submitContext = async (): Promise<SubmitContext> => ({
		deployment: await deployment(),
		reader,
		store,
		preflights,
		reprove: (s, spend) =>
			prepareBridgeSpend(s, { note: spend.spentCommitment, amount: spend.amount, portal: named.portal, recipient: spend.recipient }),
		receiptTimeoutMs: o.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
	})
	const recordsContext = async (): Promise<RecordsContext> => ({ deployment: await deployment(), reader, node, store })
	return Object.freeze({
		preflight: async (a) => preflight({ deployment: await deployment(), node, preflights }, a),
		submit: (spend, l1, s, o) => submit(submitContext, spend, l1, s, o),
		waitClaimable: async (r, o) => {
			await deployment()
			return waitClaimable(node, r, o)
		},
		claimPayload: async (s, r) => claimPayload(await deployment(), s, r),
		recover: async (s, recipient) => recover(await recordsContext(), s, recipient),
		records: async (s) => records(await recordsContext(), s),
	} satisfies BridgeClient)
}
