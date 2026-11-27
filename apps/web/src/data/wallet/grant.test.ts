import { describe, expect, test } from "vitest"
import { type AztecAction, stageManifest } from "../capabilities"
import { canDispatch } from "../actions"
import type { AztecAddress } from "../stack-types"
import { grantedAccounts, MAX_GRANTED_ACCOUNTS, parseGrant } from "./grant"

const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

describe("the grant's permission flags", () => {
	const T = { hub: address(0xa1) as AztecAddress, token: address(0xb2) as AztecAddress, sponsoredFpc: address(0xc3) as AztecAddress }
	const request = stageManifest("2b", T)
	type Cap = Record<string, unknown>
	/** The SDK's answer to `request` as asked, with `edit` applied to each capability. */
	const answer = (edit: (c: Cap) => Cap) => ({
		version: "1.0",
		granted: (JSON.parse(JSON.stringify(request.capabilities)) as Cap[])
			.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ alias: "main", item: address(0x1c4f) }] } : c))
			.map(edit),
	})
	const ALL: AztecAction[] = ["balances", "notes", "claim", "ragequit", "publicBalance", "transferPrivate", "unshield"]
	const usable = (g: ReturnType<typeof parseGrant>) => ALL.filter((a) => canDispatch(g, a, "2b", T))

	test("an SDK-shaped grant with canGet false, canRegister false or a wildcard additionalScopes grants nothing usable", () => {
		expect(
			usable(
				parseGrant(
					request,
					answer((c) => c),
				),
			),
		).toEqual(ALL)
		const noGet = parseGrant(
			request,
			answer((c) => (c.type === "accounts" ? { ...c, canGet: false } : c)),
		)
		expect(noGet.accounts).toEqual([])
		const noRegister = parseGrant(
			request,
			answer((c) => (c.type === "contracts" ? { ...c, canRegister: false } : c)),
		)
		expect(noRegister.contracts).toEqual([])
		expect(usable(noRegister)).toEqual([])
		const wildScopes = parseGrant(
			request,
			answer((c) =>
				c.type === "transaction"
					? { ...c, scope: (c.scope as Cap[]).map((s, i) => (i === 0 ? { ...s, additionalScopes: "*" } : s)) }
					: c,
			),
		)
		expect(wildScopes).toMatchObject({ contracts: [], scopes: new Set() })
	})
})

describe("the granted accounts", () => {
	test("read the wallet's answer as untrusted input", () => {
		const hostile = {
			toString() {
				throw new Error("hostile toString")
			},
		}
		const answer = {
			granted: [
				{ type: "contracts", contracts: [address(9)] },
				{
					type: "accounts",
					canGet: true,
					accounts: [
						{ item: address(1) },
						null,
						{ item: hostile },
						{ item: "not an address" },
						{ item: `0x${"f".repeat(64)}` },
						{ item: address(1) },
						{ item: { toString: () => address(2) } },
					],
				},
			],
		}
		expect(grantedAccounts(answer)).toEqual([address(1), address(2)])
		expect(grantedAccounts({ granted: "everything" })).toEqual([])
		const many = {
			granted: [{ type: "accounts", canGet: true, accounts: Array.from({ length: 40 }, (_, i) => ({ item: address(i + 1) })) }],
		}
		expect(grantedAccounts(many)).toHaveLength(MAX_GRANTED_ACCOUNTS)
	})
})
