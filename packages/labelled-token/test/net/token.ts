/** The token and its minter stub on a live network, and the reads a device makes of them. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractInstanceWithAddress } from "@aztec-labs/aztec.js/contracts"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { toWord, utf8, wordToNoirString } from "@pp/bridge-core"
import { labelledTokenArtifact } from "../../src/index"

export const stubArtifact: ContractArtifact = loadContractArtifact(
	JSON.parse(
		readFileSync(
			join(import.meta.dirname, "../../../../contracts/bridge/aztec/bridge_stub/target/bridge_stub-BridgeStub.json"),
			"utf8",
		),
	),
)

export interface Deployed {
	stub: ContractInstanceWithAddress
	token: ContractInstanceWithAddress
}

export interface Device {
	wallet: Wallet
	from: AztecAddress
	fee: Record<string, unknown>
}

export const sendOpts = (d: Device) => ({ from: d.from, fee: d.fee, wait: { waitForStatus: TxStatus.PROPOSED } })

export const deployOpts = (d: Device) => ({ from: d.from, fee: d.fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } })

/** With a zero `registry`, checked spends and shields fail with "registry unset". */
export async function deployStage(d: Device, registry: AztecAddress = AztecAddress.ZERO): Promise<Deployed> {
	const stub = await Contract.deploy(d.wallet, stubArtifact, [], undefined).send(deployOpts(d) as never)
	const word = (s: string) => wordToNoirString(toWord(utf8(s)))
	const token = await Contract.deploy(
		d.wallet,
		labelledTokenArtifact,
		[word("Labelled USD"), word("lUSD"), 6, stub.instance.address, registry],
		"constructor",
	).send(deployOpts(d) as never)
	return { stub: stub.instance, token: token.instance }
}

export async function attach(d: Device, deployed: Deployed): Promise<{ stub: Contract; token: Contract }> {
	await d.wallet.registerContract(deployed.stub, stubArtifact)
	await d.wallet.registerContract(deployed.token, labelledTokenArtifact)
	return {
		stub: Contract.at(deployed.stub.address, stubArtifact, d.wallet),
		token: Contract.at(deployed.token.address, labelledTokenArtifact, d.wallet),
	}
}

/** A simulation's value, whether or not the wallet wraps it in `{ result }`. */
export const resultOf = <T>(r: unknown): T => (r && typeof r === "object" && "result" in r ? (r as { result: T }).result : (r as T))

const entries = (v: unknown): unknown[] => {
	const { storage, len } = v as { storage: unknown[]; len: bigint | number }
	return storage.slice(0, Number(len))
}

export async function balance(token: Contract, owner: AztecAddress): Promise<bigint> {
	return BigInt(resultOf<bigint>(await token.methods.balance_of_private(owner).simulate({ from: owner } as never)))
}

export async function publicBalance(token: Contract, owner: AztecAddress): Promise<bigint> {
	return BigInt(resultOf<bigint>(await token.methods.balance_of_public(owner).simulate({ from: owner } as never)))
}

/** `(label, origin, balance)` per label, as the first page of the view returns them. */
export async function labels(token: Contract, owner: AztecAddress): Promise<[bigint, number, bigint][]> {
	const page = resultOf<unknown>(await token.methods.private_balances_by_label(owner, 0).simulate({ from: owner } as never))
	return entries(page).map((e) => {
		const [label, origin, sum] = Object.values(e as object) as [bigint, bigint | number, bigint]
		return [BigInt(label), Number(origin), BigInt(sum)]
	})
}

export async function values(token: Contract, owner: AztecAddress, label: bigint): Promise<bigint[]> {
	const page = resultOf<unknown>(await token.methods.private_notes_by_label(owner, label, 0).simulate({ from: owner } as never))
	return entries(page).map((v) => BigInt(v as bigint))
}
