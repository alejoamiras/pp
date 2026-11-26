import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import { assertGenerationBindings, BindingMismatchError, type BindingsClient, type ExpectedBindings } from "./generation-bindings"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const expected: ExpectedBindings = {
	factory: addr(0xf1),
	implementation: addr(0x1a),
	hub: `0x${"4b".repeat(32)}`,
	guardian: addr(0x6a),
	inbox: addr(0x1b),
	outbox: addr(0x0b),
	rollupVersion: 4242n,
	pool: addr(0x90),
	lifetimeCap: 10n ** 30n,
	portals: [
		{ token: addr(0x7001), portal: addr(0xc001) },
		{ token: addr(0x7002), portal: addr(0xc002) },
	],
}

/** Answers keyed `<address>.<function>[(<arg>)]`, checksummed or not; any other read throws, so a read
 *  sent to the wrong contract cannot pass. */
function chain(overrides: Record<string, unknown> = {}) {
	const answers: Record<string, unknown> = {
		[`${expected.factory}.IMPLEMENTATION`]: expected.implementation.toUpperCase().replace("0X", "0x"),
		[`${expected.factory}.L2_HUB`]: expected.hub,
		[`${expected.factory}.owner`]: expected.guardian,
		[`${expected.implementation}.FACTORY`]: expected.factory,
		[`${expected.implementation}.L2_HUB`]: expected.hub,
		[`${expected.implementation}.INBOX`]: expected.inbox,
		[`${expected.implementation}.OUTBOX`]: expected.outbox,
		[`${expected.implementation}.ROLLUP_VERSION`]: expected.rollupVersion,
		[`${expected.implementation}.POOL`]: expected.pool,
		[`${expected.implementation}.LIFETIME_CAP`]: expected.lifetimeCap,
		...Object.fromEntries(
			expected.portals.flatMap(({ token, portal }) => [
				[`${expected.factory}.portalOf(${token})`, portal],
				[`${portal}.underlying`, token],
			]),
		),
		...overrides,
	}
	const reads: string[] = []
	const client = {
		readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
			const key = `${address}.${functionName}${args?.length ? `(${args.join(",")})` : ""}`
			reads.push(key)
			if (!(key in answers)) throw new Error(`unexpected read ${key}`)
			return answers[key]
		},
	} as unknown as BindingsClient
	return { client, reads }
}

describe("assertGenerationBindings", () => {
	it("passes a generation whose every binding agrees, case-insensitively", async () => {
		const { client, reads } = chain()
		await expect(assertGenerationBindings(client, expected)).resolves.toBeUndefined()
		expect(reads).toHaveLength(10 + 2 * expected.portals.length)
	})

	it("names the first binding that disagrees, and reads no implementation the factory does not point at", async () => {
		const stranger = addr(0x5555)
		const [first, second] = expected.portals
		const cases: [string, unknown][] = [
			[`${expected.implementation}.FACTORY`, stranger],
			[`${expected.implementation}.OUTBOX`, stranger],
			[`${expected.implementation}.ROLLUP_VERSION`, expected.rollupVersion + 1n],
			[`${expected.implementation}.LIFETIME_CAP`, expected.lifetimeCap + 1n],
			[`${expected.factory}.portalOf(${second?.token})`, stranger],
			[`${first?.portal}.underlying`, stranger],
		]
		for (const [key, wrong] of cases) {
			const err = await assertGenerationBindings(chain({ [key]: wrong }).client, expected, "first-path").catch((e) => e)
			expect(err, key).toBeInstanceOf(BindingMismatchError)
			expect(err.actual, key).toBe(String(wrong))
			expect(err.message, key).toMatch(/^first-path: /)
		}
		expect(
			(await assertGenerationBindings(chain({ [`${second?.portal}.underlying`]: stranger }).client, expected).catch((e) => e))
				.binding,
		).toBe(`${second?.portal}.underlying`)

		const { client, reads } = chain({ [`${expected.factory}.IMPLEMENTATION`]: stranger })
		const err = await assertGenerationBindings(client, expected).catch((e) => e)
		expect(err.binding).toBe("factory.IMPLEMENTATION")
		expect(reads.some((r) => r.startsWith(expected.implementation))).toBe(false)
	})
})
