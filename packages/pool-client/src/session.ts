import { type Account, type Address, type Chain, type PublicClient, type Transport, toHex, type WalletClient } from "viem"
import { pinnedOriginHttpClient } from "./http.ts"
import type { Keys } from "./keys.ts"
import { createProver } from "./runtime/prover.ts"
import type { VerifiedArtifacts } from "./runtime/artifacts.ts"
import {
	AddressSchema,
	ASPClient,
	ASPRegistryInteractor,
	createEvmEntrypointInteractor,
	createEvmKeystoreInteractor,
	createEvmPoolSession,
	createEvmPoolVaultInteractor,
	EvmAddressEqualityComparator,
	EvmAddressFieldConverter,
	EvmContextHashService,
	EvmPayoutRoutingCodec,
	EvmRelayBatchCodec,
	HttpASPDataProvider,
	type IGroth16Prover,
	type IRelayerInteractor,
	MerkleService,
	NoteComputationService,
	NoteManager,
	PoseidonHashService,
	ProofService,
	TransactOrchestrator,
	ViemRPCInteractor,
	ViemWalletInteractor,
	WitnessPreparationService,
} from "./sdk.ts"
import type { PoolConfig } from "./types.ts"

export type LocalWallet = WalletClient<Transport, Chain, Account>

export type Session = {
	session: ReturnType<typeof createEvmPoolSession>
	orchestrator: TransactOrchestrator
	noteManager: NoteManager
	notes: NoteComputationService
	hash: PoseidonHashService
}

/** This package never relays, but the SDK asks for relayers before some flows. */
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

type SdkPublicClient = ConstructorParameters<typeof ViemRPCInteractor>[0]["publicClient"]
type SdkWalletClient = ConstructorParameters<typeof ViemWalletInteractor>[0]["walletClient"]

function contracts(pool: PoolConfig, publicClient: PublicClient, merkleService: MerkleService, wallet: LocalWallet | undefined) {
	// Every log scan starts at the deploy block or later: with no usable ASP snapshot the SDK rescans
	// from "0x0", which its vault adapter reads as block 0 rather than as "from deployment".
	const rpcInteractor = new ViemRPCInteractor({
		publicClient: publicClient as unknown as SdkPublicClient,
		minFromBlock: pool.deployBlock,
	})
	const writes = wallet
		? {
				walletInteractor: new ViemWalletInteractor({
					walletClient: wallet as unknown as SdkWalletClient,
					expectedChainId: pool.chainId,
				}),
			}
		: undefined
	const aspDataProvider = new HttpASPDataProvider({
		aspUrl: pool.aspApiUrl,
		chainId: pool.chainId,
		entrypointAddress: pool.entrypoint,
		httpClient: pinnedOriginHttpClient(),
	})
	const aspRegistryInteractor = new ASPRegistryInteractor({ rpcInteractor, contractAddress: pool.aspRegistry })
	return {
		rpcInteractor,
		entrypointInteractor: createEvmEntrypointInteractor({ rpcInteractor, contractAddress: pool.entrypoint }, writes),
		keystoreInteractor: createEvmKeystoreInteractor(
			{ rpcInteractor, contractAddress: pool.keystore, deploymentBlock: pool.deployBlock },
			writes,
		),
		poolVaultInteractor: createEvmPoolVaultInteractor(
			{ rpcInteractor, contractAddress: pool.poolVault, deploymentBlock: pool.deployBlock },
			writes,
		),
		aspDataProvider,
		aspClient: new ASPClient({ providers: [aspDataProvider], merkleService, aspRegistryInteractor }),
	}
}

/**
 * The SDK session (discovery, and deposit for the test seeder) and a hand-built orchestrator share one
 * NoteManager and one KeystoreManager. PoolSession keeps its own orchestrator private, and its
 * withdraw flow cannot take raw transact params.
 */
export async function createSession(d: {
	pool: PoolConfig
	owner: Address
	keys: Keys
	prover?: IGroth16Prover
	artifacts: VerifiedArtifacts
	publicClient: PublicClient
	wallet?: LocalWallet
}): Promise<Session> {
	const noteManager = new NoteManager({})
	// Discovery scans from this cursor, and the SDK's fall-back to the deploy block never fires for the
	// "0x0" it starts at: from genesis, a public node with pruned history refuses the first scan.
	noteManager.setSyncCursor(toHex(d.pool.deployBlock))
	const hashService = await PoseidonHashService.create()
	const merkleService = new MerkleService({ hashService })
	const cryptoService = d.keys.crypto
	const notes = new NoteComputationService({ hashService, cryptoService })
	const { entrypointInteractor, aspDataProvider, ...chain } = contracts(d.pool, d.publicClient, merkleService, d.wallet)
	const shared = {
		...chain,
		ownerAddress: d.owner,
		noteManager,
		keystoreManager: d.keys.keystore,
		cryptoService,
		noteComputationService: notes,
		witnessPreparationService: new WitnessPreparationService({ noteComputationService: notes, hashService, merkleService }),
		proofService: new ProofService({ circuitArtifacts: d.artifacts, groth16Prover: d.prover ?? createProver() }),
	}
	const session = createEvmPoolSession({
		...shared,
		chainId: d.pool.chainId,
		entrypointInteractor,
		hashService,
		merkleService,
		aspDataProvider,
		relayerInteractor: noRelayer(),
	})
	const orchestrator = new TransactOrchestrator({
		...shared,
		contextHashService: new EvmContextHashService(),
		payoutRoutingCodec: new EvmPayoutRoutingCodec(),
		relayBatchCodec: new EvmRelayBatchCodec(),
		addressFieldConverter: new EvmAddressFieldConverter(),
		addressEqualityComparator: new EvmAddressEqualityComparator(),
		addressSchema: AddressSchema,
	})
	return { session, orchestrator, noteManager, notes, hash: hashService }
}
