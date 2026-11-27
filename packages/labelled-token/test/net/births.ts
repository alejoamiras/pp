/** Births on a live network: a shield as its owner sends it, and what the intake and the chain show of it. */
import { type AbiType, EventSelector } from "@aztec-labs/aztec.js/abi"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import { getPublicEvents } from "@aztec-labs/aztec.js/events"
import type { TxHash, TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { EventMetadataDefinition } from "@aztec-labs/stdlib/abi"
import type { L2Base } from "@pp/bridge-core/sandbox"
import { labelledTokenArtifact } from "../../src/index"
import { land, type Proven, prove } from "./internals"
import type { Device } from "./token"

type Node = L2Base["node"]

async function eventMetadata(name: string, signature: string, fieldNames: string[]): Promise<EventMetadataDefinition> {
	const abiType = labelledTokenArtifact.outputs.structs.events?.find((e) => (e as { path?: string }).path === `LabelledToken::${name}`)
	if (!abiType) throw new Error(`the token artifact declares no ${name} event`)
	return { eventSelector: await EventSelector.fromSignature(signature), abiType: abiType as AbiType, fieldNames }
}

/** `BirthAnnouncement(Field,Field,(Field),u128)`, private, to the registry's birth intake. */
export const birthAnnouncementEvent = () =>
	eventMetadata("BirthAnnouncement", "BirthAnnouncement(Field,Field,(Field),u128)", ["label", "secret", "owner", "amount"])

/** `ShieldDebited(Field,(Field),u128)`, a public log of the shield's own tx. */
export const shieldDebitedEvent = () => eventMetadata("ShieldDebited", "ShieldDebited(Field,(Field),u128)", ["birth_id", "owner", "amount"])

export interface BirthAnnouncement {
	label: bigint
	secret: bigint
	owner: AztecAddress
	amount: bigint
	txHash: TxHash
}

export interface ShieldDebited {
	birthId: bigint
	owner: AztecAddress
	amount: bigint
}

/** Every announcement `wallet` has found for `intake`, oldest first; the wallet holds the intake's keys and the token's instance. */
export async function announcements(wallet: Wallet, token: AztecAddress, intake: AztecAddress): Promise<BirthAnnouncement[]> {
	type Raw = { label: bigint; secret: bigint; owner: AztecAddress; amount: bigint }
	const found = await wallet.getPrivateEvents<Raw>(await birthAnnouncementEvent(), { contractAddress: token, scopes: [intake] })
	return found.map(({ event, metadata }) => ({
		label: BigInt(event.label),
		secret: BigInt(event.secret),
		owner: event.owner,
		amount: BigInt(event.amount),
		txHash: metadata.txHash,
	}))
}

/** The `ShieldDebited` events `token` logged in tx `txHash`. */
export async function shieldDebits(node: Node, token: AztecAddress, txHash: TxHash): Promise<ShieldDebited[]> {
	type Raw = { birth_id: bigint; owner: AztecAddress; amount: bigint }
	const { events } = await getPublicEvents<Raw>(node as never, await shieldDebitedEvent(), { contractAddress: token, txHash })
	return events.map(({ event }) => ({ birthId: BigInt(event.birth_id), owner: event.owner, amount: BigInt(event.amount) }))
}

/** The nullifiers tx `txHash` inserted, siloed, as the chain holds them. */
export async function nullifiersOf(node: Node, txHash: TxHash): Promise<bigint[]> {
	const effect = await node.getTxEffect(txHash)
	if (!effect) throw new Error(`no effect for tx ${txHash}`)
	return effect.data.nullifiers.map((n) => n.toBigInt())
}

export interface Shielded {
	proven: Proven
	receipt: TxReceipt
}

/** Proves `d`'s shield of `amount` and sends it; the proof carries its anchor and expiry. Resolves once mined, reverted or not. */
export async function shield(d: Device & { token: Contract }, node: Node, amount: bigint): Promise<Shielded> {
	const proven = await prove(d, d.token.methods.shield(amount))
	return { proven, receipt: await land(node, proven) }
}
