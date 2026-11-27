import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import type { L2Base } from "@pp/bridge-core/sandbox"
import type { Hex } from "@pp/label-paths"
import { localBotAccounts } from "../../src/index"

/** The mock ASP publishes the grown root to the L1 ASPRegistry before it answers. */
export async function approve(aspApiUrl: string, label: bigint): Promise<void> {
	const res = await fetch(`${aspApiUrl}/admin/approve-label`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ label: `0x${label.toString(16)}` }),
	})
	if (!res.ok) throw new Error(`approve-label ${label}: ${res.status} ${await res.text()}`)
}

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
