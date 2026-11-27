import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxExecutionResult, TxStatus } from "@aztec-labs/aztec.js/tx"
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import type { Tx, TxExecutionRequest, TxProvingResult } from "@aztec-labs/stdlib/tx"
import { type Hex, readRootRecord } from "@pp/label-paths"
import { beforeAll, describe, expect, inject, it } from "vitest"
import { connectL2, type L2Base } from "../../../scripts/sandbox/l2"
import { aspRootRegistryArtifact } from "../../../src/asp-registry-artifact"

const SPEND_WINDOW = 1800n
const ORIGIN_POOL = 0
// `tree1_leaf0` in packages/bridge-spec/vectors/v1.json: a one-leaf tree, so the root is `hash_1([label])`.
const LABEL = Fr.fromHexString("0x09d4f079b636025dabd8c4897073109c88fd97d7c6bbe626b9c2176f6cc598c0")
const ROOT = Fr.fromHexString("0x237931212f0d64f612fd95fa8145f29b4224bcebd407b0b1031b9a46fec5095b")
const PATH = { index: 0, depth: 0, siblings: Array.from({ length: 18 }, () => Fr.ZERO) }
const OTHER_ROOT = new Fr(0xdeadn)

const probeArtifact: ContractArtifact = loadContractArtifact(
	JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"../../../../../contracts/bridge/aztec/asp_registry_probe/target/asp_registry_probe-AspRegistryProbe.json",
			),
			"utf8",
		),
	),
)

/**
 * Protected wallet and PXE members that prove a transaction without sending it. Not part of the
 * public Wallet API: re-check these signatures on every `@aztec-labs` bump.
 */
interface WalletInternals {
	completeFeeOptions(config: { from: AztecAddress; feePayer?: AztecAddress }): Promise<unknown>
	createTxExecutionRequestFromPayloadAndFee(payload: unknown, from: AztecAddress, fee: unknown): Promise<TxExecutionRequest>
	pxe: {
		sync(): Promise<void>
		proveTx(req: TxExecutionRequest, opts: { scopes: AztecAddress[]; senderForTags?: AztecAddress }): Promise<TxProvingResult>
	}
}

interface Proven {
	tx: Tx
	anchorTimestamp: bigint
	expirationTimestamp: bigint
}

/** Proves `call` now, so the chain can change before the same bytes are sent. */
async function prove(base: L2Base, from: AztecAddress, call: ContractFunctionInteraction): Promise<Proven> {
	const w = base.wallet as unknown as WalletInternals
	await w.pxe.sync()
	const payload = await call.request()
	const fee = await w.completeFeeOptions({ from, feePayer: payload.feePayer })
	const req = await w.createTxExecutionRequestFromPayloadAndFee(payload, from, fee)
	const proven = await w.pxe.proveTx(req, { scopes: [from], senderForTags: from })
	return {
		tx: await proven.toTx(),
		anchorTimestamp: proven.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
		expirationTimestamp: proven.publicInputs.expirationTimestamp,
	}
}

describe.skipIf(!process.env.BRIDGE_INTEGRATION)("ASP root registry on a local network", () => {
	let base: L2Base
	let from: AztecAddress
	let registry: Contract
	let probe: Contract
	let sequence = 0n

	/** Posts `poolRoot` observed at the latest Aztec block: the post lands in a later block, so
	 *  `root_time <= now` holds, and local time only moves with blocks. */
	async function post(poolRoot: Fr): Promise<void> {
		const head = await base.node.getBlockData("latest")
		if (!head) throw new Error("the node has no latest block")
		sequence += 1n
		await registry.methods
			.post_root(sequence, poolRoot, Fr.ZERO, sequence, head.header.globalVariables.timestamp, 1, 0)
			.send(base.relayerOpts as never)
	}

	async function land(proven: Proven): Promise<TxExecutionResult | undefined> {
		await base.node.sendTx(proven.tx)
		return (await waitForTx(base.node, proven.tx.getTxHash(), { dontThrowOnRevert: true })).executionResult
	}

	beforeAll(async () => {
		base = await connectL2(inject("nodeUrl"))
		from = base.relayer
		const deployOpts = { from, fee: base.fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } } as never
		registry = (await Contract.deploy(base.wallet, aspRootRegistryArtifact, [from, from, from]).send(deployOpts)).contract
		probe = (await Contract.deploy(base.wallet, probeArtifact, [registry.address]).send(deployOpts)).contract
	})

	it("lands a check with its public re-check, expiring at anchor + 1800 s", async () => {
		await post(ROOT)
		const proven = await prove(base, from, probe.methods.check_then_current(ORIGIN_POOL, LABEL, PATH))
		expect(proven.expirationTimestamp).toBe(proven.anchorTimestamp + SPEND_WINDOW)
		expect(await land(proven)).toBe(TxExecutionResult.SUCCESS)
	})

	it("lands a private-only check proved before a new root", async () => {
		await post(ROOT)
		const proven = await prove(base, from, probe.methods.check(ORIGIN_POOL, LABEL, PATH))
		await post(OTHER_ROOT)
		expect(await land(proven)).toBe(TxExecutionResult.SUCCESS)
	})

	it("reverts the public re-check of a check proved before a new root", async () => {
		await post(ROOT)
		const proven = await prove(base, from, probe.methods.check_then_current(ORIGIN_POOL, LABEL, PATH))
		// The node reports an assertion without its message, so the same bytes passing, fees enforced,
		// before the post and failing an assertion after it is what ties the revert to the new root.
		expect((await base.node.simulatePublicCalls(proven.tx, false)).revertReason).toBeUndefined()
		await post(OTHER_ROOT)
		expect((await base.node.simulatePublicCalls(proven.tx, false)).revertReason?.message).toMatch(/^Assertion failed/)
		expect(await land(proven)).toBe(TxExecutionResult.REVERTED)
	})

	it("stores both lengths with a post, read at its block, and clears them with the poster", async () => {
		const deployOpts = { from, fee: base.fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } } as never
		const fresh = (await Contract.deploy(base.wallet, aspRootRegistryArtifact, [from, from, from]).send(deployOpts)).contract
		const read = (at?: number) => readRootRecord({ aztecNode: inject("nodeUrl"), registry: fresh.address.toString() as Hex, at })
		expect(await read()).toMatchObject({ sequence: 0n, poolRoot: 0n, poolSize: 0n, birthSize: 0n })
		const head = await base.node.getBlockData("latest")
		if (!head) throw new Error("the node has no latest block")
		const sent = await fresh.methods
			.post_root(1n, new Fr(0xa1n), new Fr(0xb2n), 1n, head.header.globalVariables.timestamp, 7, 5)
			.send(base.relayerOpts as never)
		const block = (sent as unknown as { receipt: { blockNumber?: number } }).receipt.blockNumber
		expect(block).toBeDefined()
		expect(await read(block)).toMatchObject({ sequence: 1n, poolRoot: 0xa1n, birthRoot: 0xb2n, poolSize: 7n, birthSize: 5n })
		await fresh.methods.set_poster(from).send(base.relayerOpts as never)
		expect(await read()).toMatchObject({ sequence: 1n, poolRoot: 0n, birthRoot: 0n, poolSize: 0n, birthSize: 0n })
	})

	// Last: the warp cannot be undone, and an attached network is someone else's clock.
	it.skipIf(inject("attached"))("rejects a check sent after its expiry", async () => {
		await post(ROOT)
		const proven = await prove(base, from, probe.methods.check(ORIGIN_POOL, LABEL, PATH))
		await createAztecNodeDebugClient(inject("nodeUrl")).warpL2TimeAtLeastTo(Number(proven.expirationTimestamp) + 1)
		const error = await base.node.sendTx(proven.tx).then(
			() => null,
			(e: Error) => e.message,
		)
		expect(error).toMatch(/Invalid expiration timestamp/)
	})
})
