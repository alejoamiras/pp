import { describe, expect, test } from "bun:test"
import { Teardown } from "./teardown.ts"

describe("Teardown", () => {
	test("runs every step newest first, reports all failures, and runs once", async () => {
		const order: string[] = []
		const t = new Teardown()
		t.push("network", async () => {
			order.push("network")
			throw new Error("port row stuck")
		})
		t.push("pool", async () => {
			order.push("pool")
		})
		t.push("heartbeat", async () => {
			order.push("heartbeat")
			throw new Error("timer")
		})
		const first = await t.run().catch((e: unknown) => e)
		expect(order).toEqual(["heartbeat", "pool", "network"])
		expect(first).toBeInstanceOf(AggregateError)
		expect((first as AggregateError).message).toBe("teardown failed in heartbeat: timer; network: port row stuck")
		expect(await t.run().catch((e: unknown) => e)).toBe(first)
		expect(order).toHaveLength(3)
		expect(() => t.push("late", async () => {})).toThrow("teardown already ran")
	})
})
