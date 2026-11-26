import { describe, expect, test } from "vitest"
import { grantedAccounts, MAX_GRANTED_ACCOUNTS } from "./grant"

const address = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

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
		const many = { granted: [{ type: "accounts", accounts: Array.from({ length: 40 }, (_, i) => ({ item: address(i + 1) })) }] }
		expect(grantedAccounts(many)).toHaveLength(MAX_GRANTED_ACCOUNTS)
	})
})
