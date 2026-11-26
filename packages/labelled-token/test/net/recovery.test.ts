/**
 * What a holder needs to leave from a device restored from its keys alone. Balance notes go out
 * constrained under a non-interactive handshake, which is announced on chain, but an existing
 * handshake for the same (sender, recipient) pair is reused whatever its kind. A handshake another
 * app opened interactively is never announced, so a restored device finds the notes tagged under it
 * only once it is given that handshake's ephemeral key back.
 */
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import { actorAccount, connectL2, connectPeer, createActor, freshActorSecret, settled } from "@pp/bridge-core/sandbox"
import { beforeAll, describe, expect, inject, test } from "vitest"
import { handshakeResponder } from "./handshake"
import { importHandshake } from "./internals"
import { attach, balance, type Deployed, type Device, deployStage, sendOpts } from "./token"

const L = 0x1abe1n
const nodeUrl = inject("nodeUrl")

let deployed: Deployed
let secret: `0x${string}`
let holder: Device
let mine: { stub: Contract; token: Contract }
const responder = handshakeResponder()

beforeAll(async () => {
	const base = await connectL2(nodeUrl)
	deployed = await deployStage({ wallet: base.wallet, from: base.relayer, fee: base.fee })
	const peer = await connectPeer(nodeUrl, responder.hooks)
	secret = freshActorSecret()
	const actor = await createActor(peer.wallet, base.node, peer.fee, secret)
	const account = await actorAccount(peer.wallet, secret)
	responder.serve(account.secretKey, account.completeAddress)
	holder = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	mine = await attach(holder, deployed)
})

/** A device that holds only the account's keys and the contracts' public instances. */
async function restoredDevice(hooks?: Parameters<typeof connectPeer>[1]) {
	const peer = await connectPeer(nodeUrl, hooks)
	const account = await actorAccount(peer.wallet, secret)
	const device = { wallet: peer.wallet, from: account.address, fee: peer.fee }
	return { device, ...(await attach(device, deployed)) }
}

/** Polls long enough for a sync to have run, then requires the value never moved. */
async function stays<T>(read: () => Promise<T>, want: T, ms = 15_000): Promise<void> {
	const until = Date.now() + ms
	while (Date.now() < until) {
		expect(await read()).toEqual(want)
		await new Promise((r) => setTimeout(r, 1_000))
	}
}

describe("leaving from a restored device", () => {
	test("the embedded test wallet cannot open an interactive handshake", async () => {
		const plain = await restoredDevice()
		await expect(plain.stub.methods.probe_interactive_handshake().simulate({ from: plain.device.from } as never)).rejects.toThrow(
			/resolveCustomRequest/,
		)
	})

	test("a self-claim reusing an interactive self-handshake is lost to a keys-only restore until its ephemeral key is imported", async () => {
		await mine.stub.methods.probe_interactive_handshake().send(sendOpts(holder) as never)
		// The wallet simulates before it proves and each run draws a fresh ephemeral key, so the
		// landed handshake is the last one signed.
		const signer = responder.signed.at(-1)
		if (!signer) throw new Error("no handshake was signed")
		await mine.stub.methods.mint(deployed.token.address, holder.from, 40n, L).send(sendOpts(holder) as never)

		const restored = await restoredDevice()
		await stays(() => balance(restored.token, restored.device.from), 0n)
		await expect(
			restored.stub.methods.ragequit(deployed.token.address, 40n, L).simulate({ from: restored.device.from } as never),
		).rejects.toThrow(/Balance too low/)

		await importHandshake(restored.device.wallet, restored.device.from, signer)
		await settled(
			() => balance(restored.token, restored.device.from),
			(v) => v === 40n,
			"balance after the import",
		)
		await restored.stub.methods.ragequit(deployed.token.address, 40n, L).send(sendOpts(restored.device) as never)
		await settled(
			() => balance(restored.token, restored.device.from),
			(v) => v === 0n,
			"balance after leaving",
		)
	})
})
