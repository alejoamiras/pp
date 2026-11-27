/**
 * L2-side helpers shared by the operator scripts: deterministic instance derivation, the
 * manifest-bound hub and hub-token registration (recompute the recorded address, then teach the
 * wallet the instance) and the SponsoredFPC fee.
 */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
	Contract,
	type ContractBase,
	type ContractInstanceWithAddress,
	getContractInstanceFromInstantiationParams,
} from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../src/artifacts"
import { hubAt } from "../src/hub-l2"
import { deriveHubTokenInstance } from "../src/hub-token"
import type { ManifestToken, ManifestV2 } from "../src/manifest-v2"

/** The manifest's hub record: address + the salt and constructor args it derives from. */
export type ManifestHub = NonNullable<ManifestV2["bridge"]>["l2"]["hub"]

/**
 * The deterministic instance for a set of instantiation params. Both the salt and the deployer are
 * the caller's: the hub is salted with the full field of its L1 factory, and a hub-derived token
 * carries the hub itself as deployer — a wrong deployer silently yields a different address.
 */
export function deriveInstance(
	art: ContractArtifact,
	args: unknown[],
	ctor: string,
	salt: Fr,
	deployer: AztecAddress,
): Promise<ContractInstanceWithAddress> {
	return getContractInstanceFromInstantiationParams(art, {
		constructorArgs: args,
		salt,
		publicKeys: PublicKeys.default(),
		deployer,
		constructorArtifact: ctor,
	})
}

function assertDerived(label: string, instance: ContractInstanceWithAddress, recorded: string): void {
	const derived = instance.address.toString()
	if (derived.toLowerCase() !== recorded.toLowerCase()) {
		throw new Error(`manifest ${label} mismatch: derived ${derived} != recorded ${recorded}`)
	}
}

/** Teaching a wallet a contract it already knows throws; that is not a failure worth aborting on. */
async function teachWallet(wallet: Wallet, instance: ContractInstanceWithAddress, art: ContractArtifact): Promise<void> {
	try {
		await wallet.registerContractClass(art)
	} catch {}
	try {
		await wallet.registerContract(instance, art)
	} catch {}
}

/**
 * Register (never deploy) the manifest's hub, asserting the recorded address is what its salt and
 * constructor args derive. The hub is a universal deploy, so the deployer is zero.
 */
/** The hub instance the manifest record derives to; its address commits to every constructor arg. */
export function deriveHubInstance(hub: ManifestHub): Promise<ContractInstanceWithAddress> {
	const [tokenClassId, factory, aspRegistry] = hub.constructorArgs
	return deriveInstance(
		tokenBridgeHubArtifact,
		[
			Fr.fromHexString(String(tokenClassId)),
			EthAddress.fromString(String(factory)),
			AztecAddress.fromStringUnsafe(String(aspRegistry)),
		],
		hub.constructorArtifact,
		Fr.fromHexString(hub.salt),
		AztecAddress.ZERO,
	)
}

export async function registerHub(wallet: Wallet, hub: ManifestHub): Promise<ContractBase> {
	const instance = await deriveHubInstance(hub)
	assertDerived("hub", instance, hub.address)
	await teachWallet(wallet, instance, tokenBridgeHubArtifact)
	return hubAt(wallet, hub.address)
}

/**
 * Register the L2 token the hub derives for one manifest token. The wallet needs this instance to
 * simulate any hub call that reaches the token, and the assert is what proves the manifest names
 * the address the hub would actually mint to.
 */
export async function registerHubToken(
	wallet: Wallet,
	hub: AztecAddress,
	token: ManifestToken,
	tokenClassId: string,
	aspRegistry: string,
): Promise<ContractBase> {
	const instance = await deriveHubTokenInstance(hub, token.erc20, token, tokenClassId, AztecAddress.fromStringUnsafe(aspRegistry))
	assertDerived(`token ${token.displaySymbol}`, instance, token.l2Token)
	await teachWallet(wallet, instance, labelledTokenArtifact)
	return Contract.at(instance.address, labelledTokenArtifact, wallet)
}

/** Register the canonical SponsoredFPC and build its fee payment, the harness's only fee method.
 *  Registration failures are swallowed (already registered). */
export async function sponsoredFpcFee(ewallet: unknown) {
	const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	try {
		await (ewallet as { registerContract: (i: unknown, a: unknown) => Promise<unknown> }).registerContract(
			fpc,
			SponsoredFPCContract.artifact,
		)
	} catch {}
	return { fpc, fee: { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) } }
}

/** First-account bootstrap: deploy the Schnorr account when the node doesn't serve it yet.
 *  NO_FROM — the first deploy can't route through its own (not-yet-deployed) entrypoint.
 *  `log` fires with "deploying" before the (minutes-long real proof) send and "deployed"
 *  after; a caller that never logged one of the stages passes a filter. */
export async function deployAccountIfAbsent(p: {
	node: {
		getContract: (a: AztecAddress) => Promise<unknown>
		getNullifierMembershipWitness: (block: "latest", nullifier: Fr) => Promise<unknown>
	}
	manager: {
		getDeployMethod: () => Promise<{ send: (o: never) => Promise<unknown> }>
		getInstance: () => { initializationHash: Fr }
	}
	from: AztecAddress
	fee: unknown
	log: (stage: "deploying" | "deployed") => void
	/** Checked right before the send, the deploy's one write. */
	signal?: AbortSignal
}): Promise<void> {
	if (await p.node.getContract(p.from)) return
	// An account deploy publishes no instance, so the node never "serves" it: its initialization
	// nullifier is the one on-chain trace, and a re-deploy over it is rejected as an existing nullifier.
	const initNullifier = await computeSiloedPrivateInitializationNullifier(p.from, p.manager.getInstance().initializationHash)
	if (await p.node.getNullifierMembershipWitness("latest", initNullifier)) return
	p.log("deploying")
	const deployMethod = await p.manager.getDeployMethod()
	p.signal?.throwIfAborted()
	await deployMethod.send({ fee: p.fee, from: "NO_FROM" as never } as never)
	p.log("deployed")
}
