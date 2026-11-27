/**
 * The owner's session for a stack build, loaded on first sign-in: it carries the pool client, the
 * bridge client and snarkjs, which a page that never signs in does not download. The derivation
 * signature goes straight into `openBridgeSession` and is never kept; the bridge session holds the
 * keys derived from it.
 *
 * The bridge part (preflight, warm-up, prove, submit, the claim, the journal and recovery) waits for
 * the bridge client's submit and claim calls; until then each of those rejects with
 * `BRIDGE_UNAVAILABLE`, and the pool view shows the bridge as unavailable.
 */
import { type BridgeSession, openBridgeSession, parseStackManifest } from "@pp/bridge-core"
import { type ArtifactSource, secretDerivationTypedData, workerProver } from "@pp/pool-client"
import { type Hash, type PublicClient, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem"
import type { StackManifestJson } from "../../build/target"
import { BridgeFailure } from "../errors"
import type { L1TxState, Session, SessionPort, Timer } from "../ports"
import { type DelegatingProver, delegatingProver } from "./prover"

export interface SessionDeps {
	/** As the build inlined it; parsed again here with the schema the build parsed it with. */
	manifest: StackManifestJson
	reads: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">
	prover: DelegatingProver
	/** Where pool-client fetches the pinned proving files: the page's own server. */
	artifacts: ArtifactSource
	open?: typeof openBridgeSession
}

const unavailable = (): Promise<never> => Promise.reject(new BridgeFailure("BRIDGE_UNAVAILABLE"))

/** `null` for viem's not-found error, which is an answer here; anything else is an RPC failure. */
const unlessMissing = (err: unknown): null => {
	if (err instanceof TransactionReceiptNotFoundError || err instanceof TransactionNotFoundError) return null
	throw err
}

export async function l1TxState(reads: SessionDeps["reads"], hash: Hash): Promise<L1TxState> {
	if (await reads.getTransactionReceipt({ hash }).catch(unlessMissing)) return "mined"
	return (await reads.getTransaction({ hash }).catch(unlessMissing)) ? "pending" : "unknown"
}

function stackSession(s: BridgeSession, deps: SessionDeps): Session {
	return {
		owner: s.l1Address,
		notes: () => s.pool.notes(),
		nullifierOf: (commitment) => s.pool.nullifierOf(commitment),
		preflight: unavailable,
		warmUp: unavailable,
		prove: unavailable,
		cancelProve: () => deps.prover.cancel(),
		submit: unavailable,
		waitClaimable: unavailable,
		claim: unavailable,
		records: unavailable,
		recover: unavailable,
		l1TxState: (hash) => l1TxState(deps.reads, hash),
		close() {},
	}
}

export function stackSessions(deps: SessionDeps): SessionPort {
	const open = deps.open ?? openBridgeSession
	const manifest = parseStackManifest(deps.manifest)
	return {
		async open({ owner, sign }) {
			const signature = await sign(secretDerivationTypedData(owner))
			const session = await open({ manifest, l1Address: owner, signature, artifacts: deps.artifacts, prover: deps.prover })
			return stackSession(session, deps)
		},
		// This build writes no bridge record, so the device keeps none to delete.
		forget: async () => {},
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
