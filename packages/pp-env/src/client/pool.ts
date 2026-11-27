import {
	ASPClient,
	ASPRegistryInteractor,
	CryptoService,
	createEvmEntrypointInteractor,
	createEvmKeystoreInteractor,
	createEvmPoolSession,
	createEvmPoolVaultInteractor,
	type Hex as SdkHex,
	HTTPClient,
	HttpASPDataProvider,
	type IGroth16Prover,
	type IRelayerInteractor,
	KeystoreManager,
	MerkleService,
	type Note,
	NoteComputationService,
	NoteManager,
	NoteStatus,
	PoseidonHashService,
	ViemRPCInteractor,
	ViemWalletInteractor,
	WitnessPreparationService,
} from "#ppv2/evm-sdk"
import { createProver, openPoolClient, type PoolClient } from "@pp/pool-client"
import { type Address, getAddress, type Hex, keccak256, toHex, verifyTypedData } from "viem"
import { publicClientAt } from "./chain.ts"
import { secretDerivationTypedData } from "./derivation.ts"
import { createProofService } from "./prover.ts"
import { explainSpendError, poolClientOptions, toPreparedSpend } from "./spend.ts"
import type { ClientConfig, LocalWallet, PoolNote, PoolUser, PreparedSpend, SpendRequest } from "./types.ts"

type SdkPublicClient = ConstructorParameters<typeof ViemRPCInteractor>[0]["publicClient"]
type SdkWalletClient = ConstructorParameters<typeof ViemWalletInteractor>[0]["walletClient"]

/** Self-submitting sessions never relay, but the SDK asks for relayers before some flows. */
function noRelayer(): IRelayerInteractor {
	return new Proxy({} as IRelayerInteractor, {
		get: (_t, prop) =>
			prop === "getRelayers"
				? async () => []
				: () => {
						throw new Error(`relaying is not configured: ${String(prop)}()`)
					},
	})
}

/**
 * The checkout's SDK types against its own viem copy. Both copies are viem 2.45.3, so a client
 * built here is the same runtime shape, but TypeScript treats the two copies' types as unrelated.
 */
const sdkViem = <T>(client: unknown): T => client as T

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function toPoolNote(n: Note): PoolNote {
	return {
		commitment: BigInt(n.commitment),
		label: BigInt(n.label),
		value: BigInt(n.value),
		asset: getAddress(n.tokenId),
		status: n.status,
	}
}

function contracts(config: ClientConfig, wallet: LocalWallet, merkleService: MerkleService) {
	const d = config.deployment
	const deploymentBlock = d.deployBlock
	const publicClient = publicClientAt(config)
	const rpcInteractor = new ViemRPCInteractor({ publicClient: sdkViem<SdkPublicClient>(publicClient) })
	const walletInteractor = new ViemWalletInteractor({ walletClient: sdkViem<SdkWalletClient>(wallet), expectedChainId: config.chainId })
	const aspRegistryInteractor = new ASPRegistryInteractor({ rpcInteractor, contractAddress: d.aspRegistry })
	const aspDataProvider = new HttpASPDataProvider({
		aspUrl: config.aspUrl,
		chainId: config.chainId,
		entrypointAddress: d.entrypoint,
		httpClient: new HTTPClient(),
	})
	return {
		rpcInteractor,
		entrypointInteractor: createEvmEntrypointInteractor({ rpcInteractor, contractAddress: d.entrypoint }, { walletInteractor }),
		keystoreInteractor: createEvmKeystoreInteractor(
			{ rpcInteractor, contractAddress: d.keystore, deploymentBlock },
			{ walletInteractor },
		),
		poolVaultInteractor: createEvmPoolVaultInteractor(
			{ rpcInteractor, contractAddress: d.pool, deploymentBlock },
			{ walletInteractor },
		),
		aspDataProvider,
		aspClient: new ASPClient({ providers: [aspDataProvider], merkleService, aspRegistryInteractor }),
	}
}

/**
 * Registration, deposits and the notes `pickInput` chooses from. Spends go to @pp/pool-client, which
 * discovers on its own cursor, so it can refuse a note listed here (not yet seen, revoked, or hidden by the ASP).
 */
async function wireSession(
	config: ClientConfig,
	wallet: LocalWallet,
	keystoreManager: KeystoreManager,
	cryptoService: CryptoService,
	prover: IGroth16Prover,
) {
	const noteManager = new NoteManager({})
	// Discovery scans from this cursor, and the SDK's fall-back to the deploy block never fires for the
	// "0x0" it starts at: from genesis, a public node with pruned history refuses the first scan.
	noteManager.setSyncCursor(toHex(config.deployment.deployBlock) as SdkHex)
	const hashService = await PoseidonHashService.create()
	const merkleService = new MerkleService({ hashService })
	const noteComputationService = new NoteComputationService({ hashService, cryptoService })
	const session = createEvmPoolSession({
		...contracts(config, wallet, merkleService),
		chainId: config.chainId,
		ownerAddress: wallet.account.address,
		noteManager,
		keystoreManager,
		cryptoService,
		noteComputationService,
		witnessPreparationService: new WitnessPreparationService({ noteComputationService, hashService, merkleService }),
		proofService: createProofService(config, prover),
		hashService,
		merkleService,
		relayerInteractor: noRelayer(),
	})
	return { session, noteManager }
}

function pickInput(noteManager: NoteManager, asset: Address, input: bigint | undefined): Note {
	const active = noteManager.getNotes({ status: NoteStatus.ACTIVE }).filter((n) => same(n.tokenId, asset))
	const note =
		input === undefined
			? active.reduce<Note | undefined>((best, n) => (!best || BigInt(n.value) > BigInt(best.value) ? n : best), undefined)
			: active.find((n) => BigInt(n.commitment) === input)
	if (!note) throw new Error(`no active ${asset} note${input === undefined ? "" : ` with commitment ${input}`}`)
	return note
}

/** Declared fields only, read once: a later edit to the caller's object must not split one user across two configs. */
export function snapshot(c: ClientConfig): ClientConfig {
	const d = c.deployment
	const deployment = {
		pool: d.pool,
		entrypoint: d.entrypoint,
		keystore: d.keystore,
		aspRegistry: d.aspRegistry,
		deployBlock: d.deployBlock,
	}
	const bundle = c.circuitBundle
	return {
		rpcUrl: c.rpcUrl,
		chainId: c.chainId,
		deployment,
		aspUrl: c.aspUrl,
		circuitsDir: c.circuitsDir,
		...(bundle !== undefined && { circuitBundle: bundle }),
	}
}

/** One pool-client per asset, opened on first spend; a failed open is retried on the next. */
function spender(config: ClientConfig, owner: Address, signature: Hex, prover: IGroth16Prover) {
	const clients = new Map<Address, Promise<PoolClient>>()
	const clientFor = (asset: Address) => {
		const known = clients.get(asset)
		if (known) return known
		const opened = openPoolClient({ ...poolClientOptions(config, asset, owner, signature), prover })
		opened.catch(() => clients.delete(asset))
		clients.set(asset, opened)
		return opened
	}
	return async (note: Note, { processor, data, asset, amountOut }: SpendRequest): Promise<PreparedSpend> => {
		const client = await clientFor(getAddress(asset))
		const commitment = BigInt(note.commitment)
		return toPreparedSpend(
			await client.prepareSpend({ note: commitment, amount: amountOut, processor, data }).catch((e: unknown) => {
				throw explainSpendError(e, commitment)
			}),
		)
	}
}

/**
 * Builds a user whose keys derive from `signature`, or from the wallet signing the secret-derivation
 * payload. A supplied signature must be the wallet's own: any other derives keys it cannot reproduce.
 */
export async function createPoolUser(live: ClientConfig, o: { wallet: LocalWallet; signature?: Hex }): Promise<PoolUser> {
	// Read once: the signature that is verified must be the one both sides derive keys from.
	const { wallet, signature: supplied } = o
	const owner = wallet.account.address
	const typedData = secretDerivationTypedData(owner)
	if (supplied && !(await verifyTypedData({ address: owner, signature: supplied, ...typedData })))
		throw new Error(`the signature is not ${owner}'s secret-derivation signature`)
	const config = snapshot(live)
	const signature = supplied ?? (await wallet.signTypedData({ account: wallet.account, ...typedData }))
	const prover = createProver()
	const cryptoService = new CryptoService()
	const keystoreManager = KeystoreManager.fromSignature(
		{ signature, signerAddress: owner, addressHash: keccak256(owner), revocableKeyIndex: "0x0" },
		{ cryptoService },
	)
	const { session, noteManager } = await wireSession(config, wallet, keystoreManager, cryptoService, prover)
	const spend = spender(config, owner, signature, prover)
	return {
		address: owner,
		async registerKeystore() {
			const receipts = await session.registerKeystore()
			if (receipts.some((r) => !r.status)) throw new Error("keystore registration reverted")
		},
		async deposit({ asset, value }) {
			const prepared = await session.prepareDeposit({ tokenId: asset, value: toHex(value) as SdkHex })
			const receipt = await session.executeDeposit(prepared)
			if (!receipt.status) throw new Error("deposit reverted")
			return { label: BigInt(prepared.pendingNote.label), commitment: BigInt(prepared.pendingNote.commitment) }
		},
		async sync() {
			await session.discoverNotes()
		},
		notes: () => noteManager.getNotes().map(toPoolNote),
		prepareSpend: async (p) => spend(pickInput(noteManager, p.asset, p.input), p),
	}
}
