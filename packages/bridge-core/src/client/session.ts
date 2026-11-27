import { deriveClaimKey } from "@pp/bridge-spec"
import { type ArtifactSource, type IGroth16Prover, openPoolClient, type PoolClient, type PoolConfig } from "@pp/pool-client"
import { type Address, getAddress, type Hex } from "viem"
import type { StackManifest } from "../stack-manifest"
import { guarded } from "./boundary"
import { BridgeClientError } from "./errors"
import { deriveJournalKeys, type JournalKeys } from "./journal"
import { deploymentId } from "./types"

/** The pool-client methods the bridge relies on, bound once at open. */
export type SessionPool = Readonly<
	Pick<PoolClient, "notes" | "prepareSpend" | "changeOpening" | "nullifierOf" | "assertRecoverable" | "assertFresh">
>

export type SessionSecrets = { readonly claimKey: Uint8Array; readonly journal: JournalKeys }

type SessionParts = { pool: SessionPool; l1Address: Address; deploymentId: string; secrets: SessionSecrets }

const CONSTRUCT = Symbol("BridgeSession")
const sessions = new WeakSet<object>()
let secretsOf: (s: BridgeSession) => SessionSecrets

/** @throws BridgeClientError `DEPLOYMENT_MISMATCH` when the manifest carries no bridge. */
export function bridgeOf(m: StackManifest): NonNullable<StackManifest["bridge"]> {
	if (!m.bridge) throw new BridgeClientError("DEPLOYMENT_MISMATCH")
	return m.bridge
}

export function poolConfigOf(m: StackManifest): PoolConfig {
	const { poolVault, entrypoint, aspRegistry, keystore, asset, deployBlock, aspApiUrl } = m.pool
	return { chainId: m.chainId, l1Rpc: m.l1Rpc, poolVault, entrypoint, aspRegistry, keystore, asset, deployBlock, aspApiUrl }
}

/** Copies taken at open, so replacing a method on the pool client afterwards changes nothing the bridge checks. */
function bindPool(p: SessionPool): SessionPool {
	return Object.freeze({
		notes: p.notes.bind(p),
		prepareSpend: p.prepareSpend.bind(p),
		changeOpening: p.changeOpening.bind(p),
		nullifierOf: p.nullifierOf.bind(p),
		assertRecoverable: p.assertRecoverable.bind(p),
		assertFresh: p.assertFresh.bind(p),
	})
}

/**
 * One owner's bridge capability for one deployment. Only `openBridgeSession` builds one: the
 * constructor needs a module-private token, and every check recognises a session by a module-private
 * brand, so neither `Object.create` nor a copied object passes. The claim key and the journal keys
 * never leave the module; nothing serialises (`JSON.stringify` gives `{}`).
 */
export class BridgeSession {
	readonly #pool: SessionPool
	readonly #l1Address: Address
	readonly #deploymentId: string
	readonly #secrets: SessionSecrets

	static {
		secretsOf = (s) => s.#secrets
	}

	/** @throws BridgeClientError `FORGED_SESSION` unless called by `openBridgeSession`. */
	constructor(token: symbol, parts: SessionParts) {
		if (token !== CONSTRUCT) throw new BridgeClientError("FORGED_SESSION")
		this.#pool = parts.pool
		this.#l1Address = parts.l1Address
		this.#deploymentId = parts.deploymentId
		this.#secrets = parts.secrets
		sessions.add(this)
		Object.freeze(this)
	}

	get pool(): SessionPool {
		return this.#pool
	}

	get l1Address(): Address {
		return this.#l1Address
	}

	/** `chainId:portal:hub`, lower case. */
	get deploymentId(): string {
		return this.#deploymentId
	}
}

/**
 * Builds a session from a pool client that has already verified `signature` for `l1Address`.
 * Module-internal: the package exports `openBridgeSession` only.
 */
export async function sessionFromPool(pool: SessionPool, m: StackManifest, l1Address: Address, signature: Hex): Promise<BridgeSession> {
	const bridge = bridgeOf(m)
	const claimKey = deriveClaimKey(signature, l1Address)
	const journal = await deriveJournalKeys(claimKey)
	return new BridgeSession(CONSTRUCT, {
		pool: bindPool(pool),
		l1Address: getAddress(l1Address),
		deploymentId: deploymentId({ chainId: m.chainId, portal: bridge.portal, hub: bridge.hub }),
		secrets: Object.freeze({ claimKey, journal }),
	})
}

/**
 * Opens the pool client from the owner's secret-derivation signature (pool-client verifies it
 * against `secretDerivationTypedData` and `l1Address`), then derives the claim key and the journal
 * keys from the same signature. Never log or persist `signature`.
 */
export function openBridgeSession(a: {
	manifest: StackManifest
	l1Address: Address
	signature: Hex
	artifacts: ArtifactSource
	prover?: IGroth16Prover
}): Promise<BridgeSession> {
	return guarded(async () => {
		// Read once, before any await and inside the boundary: the keys must derive from the very
		// signature pool-client verified, and a throwing getter must leave as a client error.
		const { l1Address, signature, artifacts, prover } = a
		const manifest = structuredClone(a.manifest)
		bridgeOf(manifest)
		const pool = await openPoolClient({
			pool: poolConfigOf(manifest),
			l1Address,
			signature,
			artifacts,
			...(prover ? { prover } : {}),
		})
		return sessionFromPool(pool, manifest, l1Address, signature)
	})
}

/**
 * The brand and deployment check every session-taking function runs first.
 * @throws BridgeClientError `FORGED_SESSION` for anything `openBridgeSession` did not build,
 *   `SESSION_DEPLOYMENT_MISMATCH` for a session of another deployment
 */
export function useSession(s: unknown, expectedDeployment: string): { session: BridgeSession; secrets: SessionSecrets } {
	const used = brandOf(s)
	if (used.session.deploymentId !== expectedDeployment) throw new BridgeClientError("SESSION_DEPLOYMENT_MISMATCH")
	return used
}

/** The brand check alone, for callers that check the deployment their own way. @throws BridgeClientError `FORGED_SESSION` */
export function brandOf(s: unknown): { session: BridgeSession; secrets: SessionSecrets } {
	if (typeof s !== "object" || s === null || !sessions.has(s)) throw new BridgeClientError("FORGED_SESSION")
	const session = s as BridgeSession
	return { session, secrets: secretsOf(session) }
}
