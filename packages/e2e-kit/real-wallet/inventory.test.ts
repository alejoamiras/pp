import { describe, expect, it } from "vitest"
import { leakedListeners, type Owned, parseListeners } from "./inventory"

const ss = [
	'tcp   LISTEN 0      511        127.0.0.1:41001      0.0.0.0:*    users:(("bun",pid=101,fd=20),("bun",pid=102,fd=20))',
	"tcp   LISTEN 0      511          0.0.0.0:41002      0.0.0.0:*",
	'udp   UNCONN 0      0               [::]:41003         [::]:*    users:(("node",pid=103,fd=7))',
].join("\n")

describe("the leftover check's listeners", () => {
	it("reads every listening port with the pids ss can attribute", () => {
		expect([...parseListeners(ss)]).toEqual([
			[41001, [101, 102]],
			[41002, []],
			[41003, [103]],
		])
	})

	const owned: Owned = {
		owners: ["run-a"],
		ports: [41001, 41002, 41003, 41004],
		profileDir: "/p",
		listeners: { 41001: [101], 41003: [103] },
	}
	const registry: Record<number, string> = { 41002: "run-a", 41004: "someone-else" }

	it("blames the run for a port its owner still claims, or a released port a snapshot listener still holds", () => {
		const live = new Map([
			[41001, [102, 101]],
			[41002, [500]],
			[41004, [600]],
		])
		expect(leakedListeners(owned, live, (p) => registry[p])).toEqual([41001, 41002])
	})

	it("does not blame the run for a stranger that bound a released port after it", () => {
		const live = new Map([[41003, [777]]])
		expect(leakedListeners(owned, live, (p) => registry[p])).toEqual([])
	})
})
