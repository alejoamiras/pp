import { describe, expect, test, vi } from "vitest"
import type { AztecAddress } from "./stack-types"
import { canDispatch, dispatchRefusal, guardAztec, NotGrantedError } from "./actions"
import { type AztecAction, stageManifest } from "./capabilities"
import type { AztecPort } from "./ports"
import { parseGrant } from "./wallet/grant"

const at = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AztecAddress
const T = { hub: at(0xa1), token: at(0xb2), sponsoredFpc: at(0xc3) }
const ACCOUNT = at(0x1c4f)
/** The SDK hands addresses back as `AztecAddress` objects; the parser reads them through `toString`. */
const sdkAddress = (a: string) => ({ toString: () => a, toJSON: () => a })

type Cap = Record<string, unknown>
const request = stageManifest("2b", T)
/** What a wallet that grants the request as asked answers, in the SDK's shapes. */
function answer(edit: (caps: Cap[]) => Cap[] = (c) => c): unknown {
	const caps = JSON.parse(JSON.stringify(request.capabilities)) as Cap[]
	const mapped = caps.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ alias: "main", item: sdkAddress(ACCOUNT) }] } : c))
	return { version: "1.0", granted: edit(mapped), wallet: { name: "w", version: "1" } }
}
const without = (type: string) => (caps: Cap[]) => caps.filter((c) => c.type !== type)
const allowed = (ans: unknown, action: AztecAction) => canDispatch(parseGrant(request, ans), action, "2b", T)
const SENDS: AztecAction[] = ["claim", "ragequit", "transferPrivate", "unshield"]

describe("dispatch", () => {
	test("allows what was requested and granted in full", () => {
		for (const a of [...SENDS, "balances", "notes", "publicBalance"] as const) expect(allowed(answer(), a), a).toBe(true)
		expect(parseGrant(request, answer()).accounts).toEqual([ACCOUNT])
		// The 2b request does not name the public exit, whose client call comes with 2d.
		expect(dispatchRefusal(parseGrant(request, answer()), "exitPublic", "2b", T)).toBe("STAGE_UNSUPPORTED")
	})

	test("refuses every send when the grant lacks the transaction scope, and every dry run when it lacks simulation", () => {
		const noTx = answer(without("transaction"))
		for (const a of SENDS) expect(allowed(noTx, a), a).toBe(false)
		const noSim = answer(without("simulation"))
		for (const a of [...SENDS, "balances", "notes", "publicBalance"] as const) expect(allowed(noSim, a), a).toBe(false)
		expect(allowed(answer(without("contracts")), "claim")).toBe(false)
	})

	test("refuses one function the wallet dropped, and ignores what it granted beyond the request", () => {
		const dropUnshield = answer((caps) =>
			caps.map((c) => (c.type === "transaction" ? { ...c, scope: (c.scope as Cap[]).filter((s) => s.function !== "unshield") } : c)),
		)
		expect(allowed(dropUnshield, "unshield")).toBe(false)
		// A dropped scope on the token withdraws the whole contract: its other calls close too.
		expect(allowed(dropUnshield, "transferPrivate")).toBe(false)
		expect(allowed(dropUnshield, "claim")).toBe(true)
		const more = answer((caps) =>
			caps.map((c) =>
				c.type === "transaction"
					? { ...c, scope: [...(c.scope as Cap[]), { contract: sdkAddress(T.token), function: "shield" }] }
					: c,
			),
		)
		expect(canDispatch(parseGrant(request, more), "shield", "2c", T)).toBe(false)
		expect([...parseGrant(request, more).scopes].some((k) => k.endsWith("|shield"))).toBe(false)
	})

	test("grants nothing when either side carries a wildcard", () => {
		const wild = answer((caps) => caps.map((c) => (c.type === "transaction" ? { ...c, scope: "*" } : c)))
		expect(parseGrant(request, wild)).toMatchObject({ contracts: [], scopes: new Set() })
		const pattern = answer((caps) => caps.map((c) => (c.type === "contracts" ? { ...c, contracts: "*" } : c)))
		expect(allowed(pattern, "claim")).toBe(false)
	})

	test("the guarded port refuses before calling the inner port", async () => {
		const ragequit = vi.fn(async () => ({ txHash: "0x01" as const, status: "success" as const }))
		const port = guardAztec({ ragequit } as unknown as AztecPort, (a) => a !== "ragequit")
		await expect(
			port.ragequit(
				ACCOUNT,
				{ payee: "0x0000000000000000000000000000000000000001", label: 1n, amount: 1n },
				{ epoch: 1, handoff: () => {} },
			),
		).rejects.toBeInstanceOf(NotGrantedError)
		expect(ragequit).not.toHaveBeenCalled()
	})

	test("a send that reads before its handoff, or sends several functions, needs every one of them granted", async () => {
		const needs: [keyof AztecPort, AztecAction[]][] = [
			["transferPrivate", ["transferPrivate", "notes"]],
			["unshield", ["unshield", "notes"]],
			["ragequit", ["ragequit", "notes"]],
			["exitPublic", ["exitPublic", "publicBalance"]],
			["unshieldAndExit", ["unshield", "exitPublic", "notes"]],
		]
		for (const [member, actions] of needs)
			for (const withheld of actions) {
				const inner = vi.fn(async () => ({ txHash: "0x01" as const, status: "success" as const }))
				const port = guardAztec({ [member]: inner } as unknown as AztecPort, (a) => a !== withheld)
				const call = port[member] as (...a: unknown[]) => Promise<unknown>
				await expect(call(ACCOUNT, {}, { epoch: 1, handoff: () => {} }), `${member} without ${withheld}`).rejects.toMatchObject({
					action: withheld,
				})
				expect(inner, `${member} without ${withheld}`).not.toHaveBeenCalled()
			}
	})
})
