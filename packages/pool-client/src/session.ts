import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem"
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
	HTTPClient,
	HttpASPDataProvider,
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
	const rpcInteractor = new ViemRPCInteractor({ publicClient: publicClient as unknown as SdkPublicClient })
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
		httpClient: new HTTPClient(),
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
	artifacts: VerifiedArtifacts
	publicClient: PublicClient
	wallet?: LocalWallet
}): Promise<Session> {
	const noteManager = new NoteManager({})
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
		proofService: new ProofService({ circuitArtifacts: d.artifacts, groth16Prover: createProver() }),
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
	return { session, orchestrator, noteManager, notes }
}
