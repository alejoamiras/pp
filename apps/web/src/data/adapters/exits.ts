/**
 * Exits for a stack build. A ragequit goes out through the connected Aztec wallet the way a claim does;
 * its tickets, their status and their settlement come from the bridge client over the manifest's RPC
 * and node; a settle sends as a bridge spend does, pinned to its sender, behind the guard.
 */
import {
	type BridgeClient,
	type ExitTicket as CoreExitTicket,
	createBridgeClient,
	type KeyValueStore,
	parseStackManifest,
	ragequitChunks,
} from "@pp/bridge-core"
import type { StackManifestJson } from "../../build/target"
import { BridgeFailure } from "../errors"
import { parseAztecAddress } from "../parse"
import type { AztecPort, Deployment, ExitPort, ExitView } from "../ports"
import type { ExitTicket } from "../stack-types"
import { type AztecDeps, sendThroughWallet } from "./aztec"
import type { StackL1 } from "./l1"
import { asPageError } from "./page-error"

export interface ExitDeps {
	/** As the build inlined it; parsed again here with the schema the build parsed it with. */
	manifest: StackManifestJson
	deployment: Pick<Deployment, "id">
	aztec: AztecDeps
	/** A label's note values as the connected wallet reports them when called. */
	notes: AztecPort["notesByLabel"]
	l1: Pick<StackL1, "settleWallet">
	/** Tests pass their own; otherwise one over the manifest. */
	client?: BridgeClient
}

/** The exits client reads and settles tickets and never writes a bridge record. */
const NO_JOURNAL: KeyValueStore = {
	getItem: () => null,
	setItem: () => {
		throw new Error("the exits client keeps no journal")
	},
	removeItem: () => {},
}

function appTicket(t: CoreExitTicket): ExitTicket {
	const token = parseAztecAddress(t.token)
	if (token === null) throw new BridgeFailure("RPC_INCONSISTENT")
	return { ...t, token }
}

export function stackExits(d: ExitDeps): Pick<AztecPort, "ragequit"> & ExitPort {
	const client = d.client ?? createBridgeClient({ manifest: parseStackManifest(d.manifest), journal: NO_JOURNAL })
	return {
		async ragequit(from, { payee, label, amount }, on) {
			// The burn takes the label's largest notes until the amount, so only a descending prefix of the
			// notes as they are now burns with no change.
			const [chunk, ...more] = ragequitChunks(await d.notes(from, label), amount)
			if (chunk === undefined || more.length > 0) throw new BridgeFailure("NO_EXACT_CHUNKS")
			const payload = await client.ragequitPayload({ payee, amount: chunk, label })
			return sendThroughWallet(d.aztec, { epoch: on.epoch, from, payload, contracts: ["hub", "token"], handoff: () => on.handoff() })
		},
		async tickets(payee) {
			const found = await client.exitTickets({ payee })
			return Promise.all(
				found.map(
					async (t): Promise<ExitView> => ({
						key: { deployment: d.deployment.id, l2TxHash: t.l2TxHash, messageIndexInTx: t.messageIndexInTx },
						ticket: appTicket(t),
						status: await client.exitStatus(t),
					}),
				),
			)
		},
		settle: (t, from, on) =>
			client
				.settle(
					t,
					d.l1.settleWallet(from, () => on.handoff()),
				)
				.catch((err: unknown) => {
					throw asPageError(err)
				}),
	}
}
