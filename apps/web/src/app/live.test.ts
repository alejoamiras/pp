import type { Address } from "viem"
import { expect, test } from "vitest"
import { createBridgeDriver, createOutstanding } from "../data/bridge-driver"
import type { BridgeEvent } from "../data/bridge-machine"
import type { ClaimHooks, Session } from "../data/ports"
import type { AztecAddress, BridgeRecordView } from "../data/stack-types"
import { virtualTimer } from "../test-utils/timer"
import { createLiveStore } from "./live"

const OWNER: Address = "0x00000000000000000000000000000000000000a1"
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const OTHER: Address = "0x00000000000000000000000000000000000000c3"
const DEV: Address = "0x00000000000000000000000000000000000000aa"
const RECIPIENT = `0x${"1c".repeat(32)}` as AztecAddress
const DEPLOYMENT = "31337:portal:hub"
const CLAIMABLE: BridgeRecordView = { id: "r1", nullifier: 9n, recipient: RECIPIENT, amount: 70n, step: "claimable" }

test("with the demo sender chosen, a claim still pins the wallet's own Ethereum selection", async () => {
	const live = createLiveStore(DEPLOYMENT, DEV)
	live.set({ owner: OWNER, account: SENDER, chainId: 31337, epoch: 1, aztecAccounts: [RECIPIENT], demo: true })
	// A bridge sends from the dev account, so the driver's sender is it, whatever the wallet selects.
	expect(live.context().account).toBe(DEV)
	let release = () => {}
	const held = new Promise<void>((r) => (release = r))
	const sent: string[] = []
	const session = {
		async claim(_id: string, on: ClaimHooks) {
			await held
			on.handoff()
			sent.push("sendTx")
			return { txHash: "0xcc", status: "success" }
		},
	} as unknown as Session
	const driver = createBridgeDriver({
		outstanding: createOutstanding(),
		session,
		deployment: { id: DEPLOYMENT, chainId: 31337 },
		timer: virtualTimer(),
		frame: async () => {},
		context: live.context,
		canClaim: () => true,
	})
	const events: BridgeEvent[] = []
	const run = driver.claim(CLAIMABLE, (e) => events.push(e), new AbortController().signal)
	live.set({ account: OTHER })
	release()
	await run
	expect(sent).toEqual([])
	expect(events.at(-1)).toMatchObject({ type: "failed", failure: { code: "CONTEXT_CHANGED" } })
})
