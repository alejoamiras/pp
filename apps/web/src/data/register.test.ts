import type { Address, Hash, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { BridgeFailure, ProviderError, type UiCode } from "./errors"
import type { Session } from "./ports"
import { type RegisterDeps, registerOwner } from "./register"
import type { SendContext } from "./sends"
import type { RegistrationCall, RegistrationStep } from "./stack-types"

const OWNER: Address = "0x00000000000000000000000000000000000000A1"
const OTHER: Address = "0x00000000000000000000000000000000000000B2"
const KEYSTORE: Address = "0x00000000000000000000000000000000000000c3"
const CHAIN = 31337

/** What the wallet does once the guard lets a send through. */
type Wallet = "send" | "reject" | "lose" | "revert" | "no-receipt" | "mine-nothing" | "wrong-chain"

function world(o: { wallets: Wallet[]; auth?: boolean; account?: Address; stepRefuses?: UiCode }) {
	const chain = { auth: o.auth ?? false, viewing: false, block: 10n }
	const ctx: { now: SendContext } = { now: { account: o.account ?? OWNER, chainId: CHAIN, epoch: null, aztecAccounts: [] } }
	const steps: (bigint | undefined)[] = []
	const asked: RegistrationCall["function"][] = []
	const pending = new Map<Hash, { fn: RegistrationCall["function"]; wallet: Wallet }>()
	const afterReceipt: (() => void)[] = []
	let n = 0
	const session: RegisterDeps["session"] = {
		owner: OWNER,
		async registrationStep(after): Promise<RegistrationStep> {
			steps.push(after)
			if (o.stepRefuses) throw new BridgeFailure(o.stepRefuses)
			if (chain.auth && chain.viewing) return { status: "registered" }
			const fn = chain.auth ? "setViewingKey" : "setAuthPolicy"
			return { status: "send", call: { function: fn, from: OWNER, to: KEYSTORE, data: "0x01" as Hex, value: 0n } }
		},
		async sendRegistration(call, handoff) {
			const wallet = o.wallets[asked.length] ?? "send"
			// viem wraps whatever the provider throws, the guard's refusal included.
			if (wallet === "wrong-chain") throw Object.assign(new Error("chain"), { name: "ChainMismatchError" })
			try {
				handoff()
			} catch (cause) {
				throw new Error("the transaction failed", { cause })
			}
			asked.push(call.function)
			if (wallet === "reject") throw new ProviderError(4001, "User rejected the request.")
			if (wallet === "lose") throw new Error("the wallet's connection dropped")
			const hash = `0x${(++n).toString(16).padStart(64, "0")}` as Hash
			pending.set(hash, { fn: call.function, wallet })
			return hash
		},
		async registrationReceipt(hash) {
			const p = pending.get(hash)
			if (p === undefined || p.wallet === "no-receipt") return null
			chain.block++
			if (p.wallet === "send") chain[p.fn === "setAuthPolicy" ? "auth" : "viewing"] = true
			for (const f of afterReceipt.splice(0)) f()
			return { status: p.wallet === "revert" ? "reverted" : "success", blockNumber: chain.block }
		},
	} satisfies Pick<Session, "owner" | "registrationStep" | "sendRegistration" | "registrationReceipt">
	const run = () => registerOwner({ session, live: () => ctx.now, chainId: CHAIN })
	return { chain, ctx, steps, asked, afterReceipt, run }
}

const hash = (i: number) => `0x${i.toString(16).padStart(64, "0")}`

describe("registerOwner", () => {
	it("sends the two calls in order, reading each next step at the last receipt's block", async () => {
		const w = world({ wallets: [] })
		expect(await w.run()).toEqual({ ok: true })
		expect(w.asked).toEqual(["setAuthPolicy", "setViewingKey"])
		expect(w.steps).toEqual([undefined, 11n, 12n])
	})

	it.each([
		["an account that is not the owner", { account: OTHER }, { code: "REGISTER_FROM_OWNER" }, []],
		[
			"the keystore holding other keys",
			{ stepRefuses: "KEYS_REGISTERED_ELSEWHERE" as UiCode },
			{ code: "KEYS_REGISTERED_ELSEWHERE" },
			[],
		],
		["a wallet on another chain, before the handoff", { wallets: ["wrong-chain"] as Wallet[] }, { code: "CHAIN_MISMATCH" }, []],
		[
			"a declined second step",
			{ wallets: ["send", "reject"] as Wallet[] },
			{ code: "WALLET_REJECTED" },
			["setAuthPolicy", "setViewingKey"],
		],
		["a handed-off send with no hash", { wallets: ["lose"] as Wallet[] }, { code: "UNCERTAIN" }, ["setAuthPolicy"]],
		["a call with no receipt", { wallets: ["no-receipt"] as Wallet[] }, { code: "TX_UNCONFIRMED", txHash: hash(1) }, ["setAuthPolicy"]],
		[
			"a reverted call the chain still asks for",
			{ wallets: ["revert"] as Wallet[] },
			{ code: "REVERTED", txHash: hash(1) },
			["setAuthPolicy"],
		],
		[
			"a mined call the chain still asks for",
			{ wallets: ["mine-nothing"] as Wallet[] },
			{ code: "RPC_INCONSISTENT", txHash: hash(1) },
			["setAuthPolicy"],
		],
	] as const)("stops on %s", async (_, o, failure, asked) => {
		const w = world({ wallets: [], ...o })
		expect(await w.run()).toEqual({ ok: false, ...failure })
		expect(w.asked).toEqual(asked)
	})

	it("refuses the second step once the selected account changed after the first receipt", async () => {
		const w = world({ wallets: [] })
		w.afterReceipt.push(() => {
			w.ctx.now = { ...w.ctx.now, account: OTHER }
		})
		expect(await w.run()).toEqual({ ok: false, code: "CONTEXT_CHANGED" })
		expect(w.asked).toEqual(["setAuthPolicy"])
		expect(w.chain).toMatchObject({ auth: true, viewing: false })
	})

	it("goes on after a revert when the chain moved past that call, as when another tab sent it first", async () => {
		const w = world({ wallets: ["revert"] })
		w.afterReceipt.push(() => {
			w.chain.auth = true
		})
		expect(await w.run()).toEqual({ ok: true })
		expect(w.asked).toEqual(["setAuthPolicy", "setViewingKey"])
	})
})
