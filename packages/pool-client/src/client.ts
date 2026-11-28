import {
	type Address,
	createPublicClient,
	getAddress,
	type Hex,
	hexToBigInt,
	http,
	isAddressEqual,
	isHex,
	type PublicClient,
	parseEventLogs,
	toHex,
	type TransactionReceipt,
} from "viem"
import { POOL_VAULT_EVENTS_ABI } from "./abi.ts"
import { PoolClientError } from "./errors.ts"
import { type RootReader, readRoots, staleRoot } from "./fresh.ts"
import { deriveKeys, normaliseSignature, verifySigner } from "./keys.ts"
import { openNoteData } from "./note-data.ts"
import { ownRegistration, type RegistrationReader, registrationStep } from "./registration.ts"
import { type ArtifactSource, createArtifacts } from "./runtime/artifacts.ts"
import {
	BN254_SCALAR_MODULUS,
	EvmContextHashService,
	EvmPreparedTxVerifier,
	type Hex as SdkHex,
	type IGroth16Prover,
	type Note,
	type NoteComputationService,
	NoteStatus as SdkStatus,
} from "./sdk.ts"
import { createSession, type Session } from "./session.ts"
import { checkSpend, type Expected, type SpendKeys, type TransactParams } from "./spend-checks.ts"
import type {
	ChangeOpening,
	NoteData,
	NoteStatus,
	PoolClient,
	PoolConfig,
	PoolNoteView,
	PreparedSpend,
	SpendRequest,
	TransactProof,
} from "./types.ts"

const STATUS: Readonly<Record<SdkStatus, NoteStatus>> = {
	[SdkStatus.INACTIVE]: "inactive",
	[SdkStatus.PENDING]: "pending",
	[SdkStatus.ACTIVE]: "approved",
	[SdkStatus.REJECTED]: "revoked",
	[SdkStatus.SPENT]: "spent",
	[SdkStatus.EXIT_PENDING]: "exiting",
	[SdkStatus.EXITED]: "exited",
}

export const toNoteView = (n: Note): PoolNoteView => ({
	commitment: BigInt(n.commitment),
	label: BigInt(n.label),
	value: BigInt(n.value),
	asset: getAddress(n.tokenId),
	status: STATUS[n.status],
})

const LOG_WINDOW = 10_000n
const word = (n: bigint) => toHex(n, { size: 32 }) as SdkHex

function deepFreeze<T>(v: T): T {
	if (v && typeof v === "object" && !Object.isFrozen(v)) {
		for (const x of Object.values(v)) deepFreeze(x)
		Object.freeze(v)
	}
	return v
}

/** Fresh keys from the signature for every check, so no cached state can vouch for a spend. */
export function spendKeys(owner: Address, signature: Hex, notes: NoteComputationService): SpendKeys {
	const { keystore, crypto } = deriveKeys(owner, signature)
	const nullifying = keystore.getPrivateNullifyingKey()
	const viewingPrivateKey = keystore.getViewingKeyPair().privateKey
	const context = new EvmContextHashService()
	return {
		nullifierOf: (c) => BigInt(notes.computeNullifier(nullifying, word(c))),
		open: (nd) => openNoteData(nd, { notes, crypto, viewingPrivateKey, owner }),
		// The SDK returns the raw keccak; the vault reduces it mod p before comparing.
		contextOf: (p, nd) => BigInt(context.computeTransactContext(p, [...nd])) % BN254_SCALAR_MODULUS,
	}
}

type Transact = readonly [TransactProof, TransactParams, readonly NoteData[]]

function snapshotRequest(r: SpendRequest): SpendRequest {
	const { note, amount, processor, data } = r
	if (typeof note !== "bigint" || typeof amount !== "bigint") throw new TypeError("note and amount must be bigints")
	if (!isHex(data) || data.length % 2 !== 0) throw new TypeError("data must be hex of whole bytes")
	return { note, amount, processor: getAddress(processor), data: data.toLowerCase() as Hex }
}

function buildSpend(args: Transact, request: SpendRequest, change: ChangeOpening): PreparedSpend {
	const [proof, params, noteData] = args
	const signal = (row: number) => proof.pubSignals[row]?.[0] ?? -1n
	return {
		proof,
		noteData,
		processor: getAddress(params.processor),
		data: params.data,
		nullifier: signal(0),
		spentCommitment: request.note,
		change,
		amount: signal(5),
		asset: getAddress(toHex(signal(6), { size: 20 })),
		aspRoot: signal(4),
	}
}

function client(
	pool: PoolConfig,
	owner: Address,
	signature: Hex,
	sdk: Session,
	publicClient: PublicClient,
	artifacts: ReturnType<typeof createArtifacts>,
): PoolClient {
	const keys = () => spendKeys(owner, signature, sdk.notes)
	const sync = () => sdk.session.discoverNotes()
	const find = (commitment: bigint) => sdk.noteManager.getNotes().find((n) => n.isOwned && BigInt(n.commitment) === commitment)

	async function ownedNote(commitment: bigint): Promise<PoolNoteView> {
		let note = find(commitment)
		if (note === undefined) {
			await sync()
			note = find(commitment)
		}
		if (note === undefined) throw new PoolClientError("NOTE_NOT_FOUND", "this client holds no such note")
		return toNoteView(note)
	}

	const expectedFor = (r: SpendRequest, n: PoolNoteView): Expected => ({
		processor: r.processor,
		data: r.data,
		amount: r.amount,
		asset: pool.asset,
		spentCommitment: r.note,
		label: n.label,
		value: n.value,
	})

	async function prove(request: SpendRequest, note: PoolNoteView): Promise<{ args: Transact; change: ChangeOpening }> {
		await artifacts.ensure("transact_1x1")
		const amount = toHex(request.amount) as SdkHex
		const r = await sdk.orchestrator.prepareTransact({
			inputCommitments: [word(note.commitment)],
			amount,
			amountOut: amount,
			feeAmount: "0x0" as SdkHex,
			tokenId: pool.asset,
			processorAddress: request.processor,
			relayAddress: request.processor,
			recipientAddress: request.processor,
			transactParams: { processor: request.processor, data: request.data },
		})
		const { args } = new EvmPreparedTxVerifier().assertMatches(r.transactTx, { to: pool.poolVault, operation: "transact" })
		const c = r.changePendingNotes[0]
		if (c === undefined) throw new PoolClientError("SPEND_CHECK_FAILED", "shape: the SDK returned no change note", { check: "shape" })
		const precommitment = sdk.notes.computePrecommitment(c.noteAddressHash, c.tokenId, c.value)
		const change = {
			commitment: BigInt(c.commitment),
			precommitment: BigInt(precommitment),
			label: BigInt(c.label),
			value: BigInt(c.value),
		}
		return { args: args as unknown as Transact, change }
	}

	return {
		async notes() {
			await sync()
			return sdk.noteManager
				.getNotes()
				.filter((n) => n.isOwned)
				.map(toNoteView)
		},

		async prepareSpend(a) {
			const request = snapshotRequest(a)
			await sync()
			const note = await ownedNote(request.note)
			if (note.status !== "approved") throw new PoolClientError("NOTE_NOT_APPROVED", `the note is ${note.status}`)
			if (!isAddressEqual(note.asset, pool.asset)) throw new PoolClientError("ASSET_MISMATCH", "the note is not in the pool's asset")
			if (request.amount <= 0n || request.amount > note.value)
				throw new PoolClientError("AMOUNT_OUT_OF_RANGE", "amount must be in (0, note value]")
			const { args, change } = await prove(request, note)
			const spend = buildSpend(args, request, change)
			checkSpend(spend, args[1], expectedFor(request, note), keys())
			return deepFreeze(spend)
		},

		async changeOpening(spentNullifier) {
			return changeOpeningOf(spentNullifier, pool, publicClient, keys())
		},

		async nullifierOf(commitment) {
			return keys().nullifierOf((await ownedNote(commitment)).commitment)
		},

		async assertRecoverable(s) {
			const note = await ownedNote(s.spentCommitment)
			const request = { note: s.spentCommitment, amount: s.amount, processor: s.processor, data: s.data }
			checkSpend(s, { processor: s.processor, data: s.data }, expectedFor(request, note), keys())
		},

		async assertFresh(s) {
			const row = (i: number) => s.proof.pubSignals[i]?.[0] ?? -1n
			const roots = { state: row(2), keystore: row(3), asp: row(4) }
			const stale = staleRoot(roots, await readRoots(publicClient as unknown as RootReader, pool, roots))
			if (stale !== null) throw new PoolClientError(stale, "re-prove: the vault would refuse this proof's root")
		},

		async registrationStep(after) {
			if (after !== undefined && (typeof after !== "bigint" || after < 0n)) throw new TypeError("after must be a block number")
			const reader: RegistrationReader = {
				head: () => freshHead(publicClient),
				readContract: (c) => publicClient.readContract(c as Parameters<PublicClient["readContract"]>[0]),
			}
			return registrationStep(reader, pool, owner, ownRegistration(deriveKeys(owner, signature), sdk.notes, sdk.hash), after)
		},
	}
}

/**
 * The change this receipt's own `Transacted` log published for `nullifier`, or `null`. Reading both from one
 * receipt means a log list pointing at another of this client's spends cannot hand back that spend's change.
 */
export function changeInReceipt(receipt: TransactionReceipt, nullifier: bigint, pool: PoolConfig, keys: SpendKeys): ChangeOpening | null {
	if (receipt.status !== "success") return null
	const logs = receipt.logs.filter((l) => isAddressEqual(l.address, pool.poolVault))
	const spend = parseEventLogs({ abi: POOL_VAULT_EVENTS_ABI, eventName: "Transacted", logs }).find((l) =>
		l.args.nullifierHashes?.includes(nullifier),
	)
	const outputs = spend?.args.outputCommitments ?? []
	for (const n of parseEventLogs({ abi: POOL_VAULT_EVENTS_ABI, eventName: "Note", logs })) {
		const opened = keys.open({ hint: n.args.hint, data: n.args.data })
		if (opened && outputs.includes(opened.opening.commitment)) return opened.opening
	}
	return null
}

/** Not `getBlockNumber`: viem may answer that from its head cache or a head request in flight, even at `cacheTime: 0`. */
export async function freshHead(client: Pick<PublicClient, "request">): Promise<bigint> {
	return hexToBigInt(await client.request({ method: "eth_blockNumber" }))
}

async function changeOpeningOf(nullifier: bigint, pool: PoolConfig, publicClient: PublicClient, keys: SpendKeys): Promise<ChangeOpening> {
	const latest = await freshHead(publicClient)
	for (let from = pool.deployBlock; from <= latest; from += LOG_WINDOW) {
		const to = from + LOG_WINDOW - 1n < latest ? from + LOG_WINDOW - 1n : latest
		const logs = await publicClient.getLogs({ address: pool.poolVault, event: POOL_VAULT_EVENTS_ABI[0], fromBlock: from, toBlock: to })
		const hit = logs.find((l) => l.args.nullifierHashes?.includes(nullifier))
		if (hit === undefined) continue
		const receipt = await publicClient.getTransactionReceipt({ hash: hit.transactionHash })
		const opening = changeInReceipt(receipt, nullifier, pool, keys)
		if (opening) return opening
		throw new PoolClientError("NULLIFIER_NOT_FOUND", "the spend's change does not open to this client's keys")
	}
	throw new PoolClientError("NULLIFIER_NOT_FOUND", "no spend published this nullifier")
}

/** Opens a client for the user whose wallet made `signature` over `secretDerivationTypedData(l1Address)`. */
export async function openPoolClient(a: {
	pool: PoolConfig
	l1Address: Address
	signature: Hex
	artifacts: ArtifactSource
	/** Defaults to proving on the calling thread; pass `workerProver(...)` to keep a page responsive. */
	prover?: IGroth16Prover
}): Promise<PoolClient> {
	const signature = normaliseSignature(a.signature)
	const owner = getAddress(a.l1Address)
	// Read once, field by field so prototype getters count: the chain the bundle is allowed for is the one the
	// RPC is held to and the session runs on.
	const { chainId: poolChain, l1Rpc, poolVault, entrypoint, aspRegistry, keystore, asset, deployBlock, aspApiUrl } = a.pool
	const pool: PoolConfig = { chainId: poolChain, l1Rpc, poolVault, entrypoint, aspRegistry, keystore, asset, deployBlock, aspApiUrl }
	const artifacts = createArtifacts(a.artifacts, { chainId: pool.chainId })
	await verifySigner(owner, signature)
	// CCIP-read off: a contract another party controls must not answer a read with a URL to fetch.
	const publicClient = createPublicClient({ transport: http(pool.l1Rpc), ccipRead: false })
	const chainId = await publicClient.getChainId()
	if (chainId !== pool.chainId) throw new PoolClientError("CHAIN_MISMATCH", `RPC serves chain ${chainId}, the pool is on ${pool.chainId}`)
	const sdk = await createSession({ pool, owner, keys: deriveKeys(owner, signature), artifacts, publicClient, prover: a.prover })
	return client(pool, owner, signature, sdk, publicClient, artifacts)
}
