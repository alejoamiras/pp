import {
	AddressSchema,
	ASPClient,
	ASPRegistryInteractor,
	CryptoService,
	createEvmEntrypointInteractor,
	createEvmKeystoreInteractor,
	createEvmPoolSession,
	createEvmPoolVaultInteractor,
	EvmAddressEqualityComparator,
	EvmAddressFieldConverter,
	EvmContextHashService,
	EvmPayoutRoutingCodec,
	EvmRelayBatchCodec,
	type Hex as SdkHex,
	HTTPClient,
	HttpASPDataProvider,
	type IRelayerInteractor,
	KeystoreManager,
	MerkleService,
	type Note,
	NoteComputationService,
	NoteManager,
	NoteStatus,
	PoseidonHashService,
	TransactOrchestrator,
	ViemRPCInteractor,
	ViemWalletInteractor,
	WitnessPreparationService,
} from "@ppv2/evm-sdk"
import { type Address, createPublicClient, decodeFunctionData, getAddress, type Hex, http, keccak256, toHex } from "viem"
import { POOL_VAULT_TRANSACT_ABI } from "./abi.ts"
import { secretDerivationTypedData } from "./derivation.ts"
import { createProofService } from "./prover.ts"
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

type Sdk = { session: ReturnType<typeof createEvmPoolSession>; orchestrator: TransactOrchestrator; noteManager: NoteManager }

function contracts(config: ClientConfig, wallet: LocalWallet, merkleService: MerkleService) {
	const d = config.deployment
	const deploymentBlock = d.deployBlock
	const publicClient = createPublicClient({ transport: http(config.rpcUrl), pollingInterval: 100 })
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
 * The SDK session (keys, deposit, discovery) and the spend orchestrator share one NoteManager and
 * one KeystoreManager, so both see the same notes.
 */
async function wireSdk(
	config: ClientConfig,
	wallet: LocalWallet,
	keystoreManager: KeystoreManager,
	cryptoService: CryptoService,
): Promise<Sdk> {
	const noteManager = new NoteManager({})
	const hashService = await PoseidonHashService.create()
	const merkleService = new MerkleService({ hashService })
	const noteComputationService = new NoteComputationService({ hashService, cryptoService })
	const { entrypointInteractor, aspDataProvider, ...chain } = contracts(config, wallet, merkleService)
	const shared = {
		...chain,
		ownerAddress: wallet.account.address,
		noteManager,
		keystoreManager,
		cryptoService,
		noteComputationService,
		witnessPreparationService: new WitnessPreparationService({ noteComputationService, hashService, merkleService }),
		proofService: createProofService(config.circuitsDir),
	}
	const session = createEvmPoolSession({
		...shared,
		chainId: config.chainId,
		entrypointInteractor,
		hashService,
		merkleService,
		aspDataProvider,
		relayerInteractor: noRelayer(),
	})
	// PoolSession keeps its orchestrator private, and its withdraw flow cannot take raw transactParams.
	const orchestrator = new TransactOrchestrator({
		...shared,
		contextHashService: new EvmContextHashService(),
		payoutRoutingCodec: new EvmPayoutRoutingCodec(),
		relayBatchCodec: new EvmRelayBatchCodec(),
		addressFieldConverter: new EvmAddressFieldConverter(),
		addressEqualityComparator: new EvmAddressEqualityComparator(),
		addressSchema: AddressSchema,
	})
	return { session, orchestrator, noteManager }
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

async function prepareSpend(sdk: Sdk, pool: Address, { processor, data, asset, amountOut, input }: SpendRequest): Promise<PreparedSpend> {
	const note = pickInput(sdk.noteManager, asset, input)
	const amount = toHex(amountOut) as SdkHex
	const r = await sdk.orchestrator.prepareTransact({
		inputCommitments: [note.commitment],
		amount,
		amountOut: amount,
		feeAmount: "0x0" as SdkHex,
		tokenId: asset,
		processorAddress: processor,
		relayAddress: processor,
		recipientAddress: processor,
		transactParams: { processor, data },
	})
	if (!same(r.transactTx.to, pool)) throw new Error(`SDK built a transact to ${r.transactTx.to}, not the pool ${pool}`)
	const { args } = decodeFunctionData({ abi: POOL_VAULT_TRANSACT_ABI, data: r.transactTx.data })
	const signals = args[0].pubSignals
	const [nullifier, changeCommitment] = [signals[0]?.[0], signals[1]?.[0]]
	const change = r.changePendingNotes[0]
	if (nullifier === undefined || changeCommitment === undefined || !change)
		throw new Error("SDK built a spend without one input and one output")
	return {
		args,
		input: BigInt(note.commitment),
		nullifier,
		changeCommitment,
		changeValue: BigInt(change.value),
		amountOut,
		asset: getAddress(asset),
		label: BigInt(note.label),
	}
}

/** Builds a user whose keys derive from `signature`, or from the wallet signing the secret-derivation payload. */
export async function createPoolUser(config: ClientConfig, o: { wallet: LocalWallet; signature?: Hex }): Promise<PoolUser> {
	const { wallet } = o
	const owner = wallet.account.address
	const signature = o.signature ?? (await wallet.signTypedData({ account: wallet.account, ...secretDerivationTypedData(owner) }))
	const cryptoService = new CryptoService()
	const keystoreManager = KeystoreManager.fromSignature(
		{ signature, signerAddress: owner, addressHash: keccak256(owner), revocableKeyIndex: "0x0" },
		{ cryptoService },
	)
	const sdk = await wireSdk(config, wallet, keystoreManager, cryptoService)
	const { session, noteManager } = sdk
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
		prepareSpend: (p) => prepareSpend(sdk, config.deployment.pool, p),
	}
}
