import { encodeAbiParameters, encodeEventTopics, type Hex, type Log, type TransactionReceipt } from "viem"
import { expect, it } from "vitest"
import { POOL_VAULT_EVENTS_ABI } from "../../src/abi.ts"
import { changeInReceipt } from "../../src/client.ts"
import type { PoolConfig } from "../../src/types.ts"
import { spendFixture } from "../support/spend-fixture.ts"

const VAULT = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0"
const ANYONE = "0x0000000000000000000000000000000000000002"
const pool = { poolVault: VAULT } as unknown as PoolConfig

const transacted = (outputs: bigint[], nullifiers: bigint[]) =>
	({
		address: VAULT,
		topics: encodeEventTopics({ abi: POOL_VAULT_EVENTS_ABI, eventName: "Transacted", args: { asset: ANYONE, caller: ANYONE } }),
		data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }, { type: "uint256" }], [outputs, nullifiers, 0n]),
	}) as unknown as Log
const note = (hint: Hex, data: Hex) =>
	({
		address: VAULT,
		topics: encodeEventTopics({ abi: POOL_VAULT_EVENTS_ABI, eventName: "Note", args: { hint } }),
		data: encodeAbiParameters([{ type: "bytes" }], [data]),
	}) as unknown as Log
const receipt = (logs: Log[], status: "success" | "reverted" = "success") => ({ status, logs }) as TransactionReceipt

it("opens the change only from a successful receipt whose own Transacted log names the nullifier", async () => {
	const { spend, keys } = await spendFixture()
	const [nd] = spend.noteData
	const change = note(nd!.hint, nd!.data)
	const own = transacted([spend.change.commitment], [spend.nullifier])

	expect(changeInReceipt(receipt([own, change]), spend.nullifier, pool, keys)).toEqual(spend.change)
	// Another spend's receipt: its note opens to this client, but under a different nullifier.
	expect(
		changeInReceipt(receipt([transacted([spend.change.commitment], [spend.nullifier + 1n]), change]), spend.nullifier, pool, keys),
	).toBeNull()
	expect(changeInReceipt(receipt([own, change], "reverted"), spend.nullifier, pool, keys)).toBeNull()
	expect(
		changeInReceipt(
			receipt([{ ...own, address: "0x0000000000000000000000000000000000000001" } as Log, change]),
			spend.nullifier,
			pool,
			keys,
		),
	).toBeNull()
})
