// `unshield` refuses to run before `end_setup`, where its effects would not revert with its public
// step. TXE marks every top-level call revertible and bypasses the account entrypoint, so only a
// real fee-payment call can put it in the setup phase.
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { mergeExecutionPayloads } from "@aztec-labs/aztec.js/tx"
import { connectL2, connectPeer, createActor, freshActorSecret, settled } from "@pp/bridge-core/sandbox"
import { beforeAll, describe, expect, inject, test } from "vitest"
import { deployRegistry, type Registry, tree } from "./registry"
import { attach, balance, type Deployed, type Device, deployStage, sendOpts } from "./token"

const L = 0x1abe1n
const LIVE = tree([L])
const BIRTH = tree([0xb1abe1n])
const nodeUrl = inject("nodeUrl")

let deployed: Deployed
let registry: Registry
let holder: Device & { stub: Contract; token: Contract }

beforeAll(async () => {
	const base = await connectL2(nodeUrl)
	const minter = { wallet: base.wallet, from: base.relayer, fee: base.fee }
	registry = await deployRegistry(minter, base.node)
	deployed = await deployStage(minter, registry.address)
	const peer = await connectPeer(nodeUrl)
	const actor = await createActor(peer.wallet, base.node, peer.fee, freshActorSecret())
	const d = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	holder = { ...d, ...(await attach(d, deployed)) }
	await holder.stub.methods.mint(deployed.token.address, holder.from, 10n, L).send(sendOpts(holder) as never)
	await settled(
		() => balance(holder.token, holder.from),
		(v) => v === 10n,
		"balance 10",
	)
})

/** `sponsor` with `call` run ahead of it, before the sponsor ends the setup phase. */
function runInSetup(sponsor: FeePaymentMethod, call: { request(): Promise<unknown> }): FeePaymentMethod {
	return {
		getAsset: () => sponsor.getAsset(),
		getFeePayer: () => sponsor.getFeePayer(),
		getGasSettings: () => sponsor.getGasSettings(),
		getExecutionPayload: async () => mergeExecutionPayloads([(await call.request()) as never, await sponsor.getExecutionPayload()]),
	}
}

describe("phase", () => {
	test('an unshield run as a setup-phase call fails in simulation with "setup phase"', async () => {
		await registry.post(LIVE.root, BIRTH.root)
		const unshield = holder.token.methods.unshield(5n, L, LIVE.path(L))
		// The same call in the app phase simulates, so the phase is the only difference.
		await unshield.simulate({ from: holder.from, fee: holder.fee } as never)
		const sponsor = holder.fee.paymentMethod as FeePaymentMethod
		const app = holder.stub.methods.mint(deployed.token.address, holder.from, 1n, L)
		await expect(
			app.simulate({ from: holder.from, fee: { ...holder.fee, paymentMethod: runInSetup(sponsor, unshield) } } as never),
		).rejects.toThrow(/setup phase/)
	})
})
