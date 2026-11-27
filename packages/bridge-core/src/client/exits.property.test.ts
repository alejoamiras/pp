import * as fc from "fast-check"
import type { Hex } from "viem"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { BridgeClientError } from "./errors"
import { messageIndices } from "./exits"

/** Drawn from a pool of at most four hashes, so repeats, shortages and duplicate exits occur by construction. */
const pool = fc.uniqueArray(fc.stringMatching(/^[0-9a-f]{64}$/), { minLength: 1, maxLength: 4 })
const drawn = (hashes: readonly string[]) =>
	fc.array(
		fc.tuple(fc.constantFrom(...hashes), fc.boolean()).map(([h, upper]) => `0x${upper ? h.toUpperCase() : h}` as Hex),
		{ maxLength: 12 },
	)

/** The k-th ticket for a hash takes that hash's k-th occurrence, compared without case. */
function queued(tickets: readonly Hex[], messages: readonly Hex[]): number[] | "RPC_INCONSISTENT" {
	const queues = new Map<string, number[]>()
	for (const [i, m] of messages.entries()) queues.set(m.toLowerCase(), [...(queues.get(m.toLowerCase()) ?? []), i])
	const out: number[] = []
	for (const t of tickets) {
		const next = queues.get(t.toLowerCase())?.shift()
		if (next === undefined) return "RPC_INCONSISTENT"
		out.push(next)
	}
	return out
}

const outcome = (tickets: readonly Hex[], messages: readonly Hex[]): number[] | "RPC_INCONSISTENT" => {
	try {
		return messageIndices(tickets, messages)
	} catch (e) {
		if (e instanceof BridgeClientError && e.code === "RPC_INCONSISTENT") return "RPC_INCONSISTENT"
		throw e
	}
}

describe("messageIndices", () => {
	const name = "each ticket takes its hash's next unused occurrence, or the read is inconsistent"
	const p = propertyParams(import.meta.url, name, 300, 500)
	it(
		name,
		() => {
			fc.assert(
				fc.property(
					pool.chain((hs) => fc.tuple(drawn(hs), drawn(hs))),
					([tickets, messages]) => {
						const got = outcome(tickets, messages)
						const short = [...new Set(tickets.map((t) => t.toLowerCase()))].some(
							(h) =>
								tickets.filter((t) => t.toLowerCase() === h).length > messages.filter((m) => m.toLowerCase() === h).length,
						)
						expect(got === "RPC_INCONSISTENT", "RPC_INCONSISTENT iff a hash has more tickets than occurrences").toBe(short)
						expect(got).toEqual(queued(tickets, messages))
						if (got === "RPC_INCONSISTENT") return
						expect(got, "one index per ticket").toHaveLength(tickets.length)
						expect(new Set(got).size, "distinct indices").toBe(got.length)
					},
				),
				p.fc,
			)
		},
		p.testTimeout,
	)
})
