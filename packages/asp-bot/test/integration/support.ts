import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import type { L2Base } from "@pp/bridge-core/sandbox"
import type { Hex } from "@pp/label-paths"
import { localBotAccounts } from "../../src/index"

async function labelAdmin(aspApiUrl: string, route: "approve-label" | "revoke-label", label: bigint): Promise<void> {
	const res = await fetch(`${aspApiUrl}/admin/${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ label: `0x${label.toString(16)}` }),
	})
	if (!res.ok) throw new Error(`${route} ${label}: ${res.status} ${await res.text()}`)
}

/** The mock ASP publishes the grown root to the L1 ASPRegistry before it answers. */
export const approve = (aspApiUrl: string, label: bigint) => labelAdmin(aspApiUrl, "approve-label", label)

/** Publishes the shrunken root to L1 before it answers; a leaf must remain, since L1 refuses root 0. */
export const revoke = (aspApiUrl: string, label: bigint) => labelAdmin(aspApiUrl, "revoke-label", label)

/** A fresh registry whose poster and birth intake are the bot's accounts for `stackRunId`. */
export async function deployRegistry(base: L2Base, stackRunId: string): Promise<Hex> {
	const accounts = await localBotAccounts(stackRunId)
	const args = [base.relayer, AztecAddress.fromStringUnsafe(accounts.poster), AztecAddress.fromStringUnsafe(accounts.birthIntake)]
	const salt = Fr.random()
	const instance = await getContractInstanceFromInstantiationParams(aspRootRegistryArtifact, {
		constructorArgs: args,
		salt,
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.ZERO,
		constructorArtifact: "constructor",
	})
	await Contract.deploy(base.wallet, aspRootRegistryArtifact, args, "constructor", { salt, universalDeploy: true } as never).send({
		...base.relayerOpts,
		wait: { waitForStatus: TxStatus.CHECKPOINTED, timeout: 300 },
	} as never)
	if (!(await base.node.getContract(instance.address))) throw new Error("registry is not at its derived address")
	return instance.address.toString() as Hex
}
