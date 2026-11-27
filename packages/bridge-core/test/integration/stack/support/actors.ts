/**
 * The bridge suite's actors on the attached stack. The actors themselves live in
 * `scripts/stack-actors.ts`, shared with the stack's scripts; this adds what only the suite needs:
 * devices whose stores sit in a per-case scratch directory, chain time, and fee and balance reads.
 */
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { createPublicClient, createTestClient, http } from "viem"
import { balanceOf } from "../../../../scripts/sandbox/context"
import { chainOf, type Device, device as stackDevice } from "../../../../scripts/stack-actors"
import { labelledTokenArtifact } from "../../../../src/artifacts"
import { type AttachedStack, scratch } from "./stack"

export {
	type Account,
	account,
	chainOf,
	type Device,
	fundedIndex,
	type Note,
	type Owner,
	owner,
	seedOf,
	send,
	sender,
	sessionOf,
} from "../../../../scripts/stack-actors"

/** A device whose wallet store lives in a scratch directory named for `name`, removed when it stops. */
export async function device(m: AttachedStack, name: string, o: { knowsFpc?: boolean } = {}): Promise<Device> {
	const dir = scratch(name)
	const d = await stackDevice(m, { ...o, dataDirectory: dir.path }).catch((e: unknown) => {
		dir.remove()
		throw e
	})
	return {
		...d,
		async stop() {
			try {
				await d.stop()
			} finally {
				dir.remove()
			}
		},
	}
}

/**
 * Moves L1 chain time forward by `seconds` and mines a block there. The stack's anvil ignores
 * `evm_increaseTime`; a pinned next-block timestamp holds.
 */
export async function advanceChainTime(m: AttachedStack, seconds: number): Promise<void> {
	const test = createTestClient({ chain: chainOf(m), transport: http(m.l1Rpc), mode: "anvil" })
	const { timestamp } = await createPublicClient({ transport: http(m.l1Rpc) }).getBlock()
	await test.setNextBlockTimestamp({ timestamp: timestamp + BigInt(seconds) })
	await test.mine({ blocks: 1 })
}

export const feeJuice = (d: Device, who: AztecAddress) => getFeeJuiceBalance(who, d.node)

/** `who`'s Fee Juice as of the end of L2 block `block`. */
export async function feeJuiceAt(d: Device, who: AztecAddress, block: number): Promise<bigint> {
	const slot = await deriveStorageSlotInMap(new Fr(1), who)
	return (await d.node.getPublicStorageAt(block as never, ProtocolContractAddress.FeeJuice, slot)).toBigInt()
}

/** The fees every transaction in L2 block `block` paid, in order. */
export async function blockFees(d: Device, block: number): Promise<bigint[]> {
	const b = await d.node.getBlock(block as never, { includeTransactions: true })
	if (!b) throw new Error(`the node has no block ${block}`)
	return b.body.txEffects.map((t) => t.transactionFee.toBigInt())
}

/** A simulated utility or view call's result, unwrapped from aztec.js's `{ result }` when present. */
const resultOf = (r: unknown): unknown => (r as { result?: unknown }).result ?? r

/** `holder`'s private balance rows, `[label, origin, value]`, first page, read through `d`'s own wallet. */
export async function labelRows(d: Device, holder: AztecAddress): Promise<[bigint, number, bigint][]> {
	const token = await Contract.at(d.token, labelledTokenArtifact, d.wallet as never)
	const page = resultOf(await token.methods.private_balances_by_label(holder, 0).simulate({ from: holder } as never)) as
		| { storage?: unknown[]; len?: bigint | number }
		| unknown[]
	const rows = (Array.isArray(page) ? page : (page.storage ?? []).slice(0, Number(page.len ?? 0))) as [bigint, bigint, bigint][]
	return rows.map(([l, o, v]) => [BigInt(l), Number(o), BigInt(v)])
}

/** `holder`'s private balance under `label`, read through `d`'s own wallet. */
export async function labelBalance(d: Device, holder: AztecAddress, label: bigint): Promise<bigint> {
	return (await labelRows(d, holder)).filter(([l]) => l === label).reduce((sum, [, , v]) => sum + v, 0n)
}

/** `holder`'s public balance of the stack's labelled token. */
export async function publicBalance(d: Device, holder: AztecAddress): Promise<bigint> {
	return balanceOf(await Contract.at(d.token, labelledTokenArtifact, d.wallet as never), holder, "public")
}
