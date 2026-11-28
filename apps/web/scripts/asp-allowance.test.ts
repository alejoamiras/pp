import { describe, expect, test } from "vitest"
import { aspAllowance, MAX_URLS } from "./asp-allowance"
import type { Forwarded } from "./proxy"

const ASP = "https://asp.example"
const SCOPE = `chainId=11155111&entrypoint=0x${"11".repeat(20)}`
const URL = {
	root: `${ASP}/association-set/root?${SCOPE}`,
	leaves: `${ASP}/association-set/leaves?${SCOPE}`,
	key: `${ASP}/public-key`,
	snapshot: `${ASP}/11155111/public/event-snapshot/payload?entrypoint=0x${"11".repeat(20)}`,
}
const MIN = 60_000

const ok = (text: string): Forwarded => ({ ok: true, status: 200, body: new TextEncoder().encode(text) })
const rootOf = (r: string) => ok(`{"root":"${r}"}`)
const leavesOf = (r: string) => ok(`{"leaves":["${r}0"]}`)

/** A counting upstream answering `answers[url]` (a 200 `{}` by default), behind a clock the test moves. */
function rig() {
	let now = 0
	const calls: Record<string, number> = {}
	const answers: Record<string, () => Promise<Forwarded>> = {}
	const ask = aspAllowance(
		(url) => {
			calls[url] = (calls[url] ?? 0) + 1
			return answers[url]?.() ?? Promise.resolve(ok("{}"))
		},
		URL.root,
		() => now,
	)
	return { ask, calls, answers, at: (ms: number) => (now = ms) }
}

const text = async (r: Promise<Forwarded>) => {
	const f = await r
	return f.ok ? new TextDecoder().decode(f.body) : f.reason
}

describe("the operator's ASP allowance", () => {
	test("tabs polling every 6 s for 10 minutes cost at most two requests per URL, and the leaves one under an unchanged root", async () => {
		const r = rig()
		r.answers[URL.root] = async () => rootOf("7")
		r.answers[URL.leaves] = async () => leavesOf("7")
		const poll = async () => {
			await r.ask(URL.root, "root")
			await r.ask(URL.leaves, "leaves")
			await r.ask(URL.key, "public-key")
			await r.ask(URL.snapshot, "snapshot")
		}
		for (let t = 0; t < 10 * MIN; t += 6_000) {
			r.at(t)
			await Promise.all(Array.from({ length: 5 }, poll))
		}
		expect(r.calls).toEqual({ [URL.root]: 2, [URL.leaves]: 1, [URL.key]: 1, [URL.snapshot]: 2 })
	})

	test("leaves follow the root for a page that only asks for the leaves", async () => {
		const r = rig()
		let root = "1"
		r.answers[URL.root] = async () => rootOf(root)
		r.answers[URL.leaves] = async () => leavesOf(root)
		await r.ask(URL.root, "root")
		const served: string[] = []
		for (let t = 0; t < 12 * MIN; t += 6_000) {
			r.at(t)
			if (t === 4 * MIN) root = "2"
			served.push(...(await Promise.all(Array.from({ length: 3 }, () => text(r.ask(URL.leaves, "leaves"))))))
		}
		expect(served.at(-1)).toBe(await text(Promise.resolve(leavesOf("2"))))
		expect(r.calls).toEqual({ [URL.root]: 3, [URL.leaves]: 2 })
	})

	test("asks for the leaves again once the root answer changes, but not within five minutes of the last ask", async () => {
		const r = rig()
		let root = "1"
		r.answers[URL.root] = async () => rootOf(root)
		r.answers[URL.leaves] = async () => leavesOf(root)
		r.at(1 * MIN)
		expect(await text(r.ask(URL.leaves, "leaves"))).toBe(await text(Promise.resolve(leavesOf("1"))))
		root = "2"
		r.at(6 * MIN - 1)
		await r.ask(URL.root, "root")
		expect(await text(r.ask(URL.leaves, "leaves")), "inside the leaves' window").toBe(await text(Promise.resolve(leavesOf("1"))))
		r.at(6 * MIN)
		expect(await text(r.ask(URL.leaves, "leaves"))).toBe(await text(Promise.resolve(leavesOf("2"))))
		expect(r.calls[URL.leaves]).toBe(2)
	})

	test("keeps the leaves while the root stays the same, whatever its answer's bytes, and while the root's request fails", async () => {
		const r = rig()
		r.answers[URL.leaves] = async () => leavesOf("7")
		const timeout: Forwarded = { ok: false, reason: "timeout" }
		for (const [t, answer] of [
			[0, ok('{"root":"7"}')],
			[5 * MIN, ok('{"root":"0x07","at":1}')],
			[10 * MIN, ok('{"at":2,"root":"007"}')],
			[15 * MIN, timeout],
		] as const) {
			r.at(t)
			r.answers[URL.root] = async () => answer
			expect(await text(r.ask(URL.leaves, "leaves")), `at ${t} ms`).toBe(await text(Promise.resolve(leavesOf("7"))))
		}
		expect(r.calls).toEqual({ [URL.root]: 4, [URL.leaves]: 1 })
	})

	test("a root or leaves 200 of another shape, or over the SDK's leaves, is a failure for its window", async () => {
		const r = rig()
		r.answers[URL.root] = async () => ok("<html>try later</html>")
		expect(await text(r.ask(URL.root, "root"))).toBe("the root answer is not JSON")
		r.answers[URL.root] = async () => rootOf("1")
		r.answers[URL.leaves] = async () => ok(JSON.stringify({ leaves: Array(2 ** 18 + 1).fill("1") }))
		r.at(5 * MIN)
		expect(await text(r.ask(URL.leaves, "leaves"))).toBe(`more than ${2 ** 18} leaves`)
		r.answers[URL.leaves] = async () => leavesOf("1")
		r.at(10 * MIN)
		expect(await text(r.ask(URL.leaves, "leaves")), "not kept under an unchanged root").toBe(await text(Promise.resolve(leavesOf("1"))))
		expect(r.calls).toEqual({ [URL.root]: 3, [URL.leaves]: 2 })
	})

	test("binds leaves only to a root whose latest ask succeeded", async () => {
		const r = rig()
		r.answers[URL.root] = async () => rootOf("1")
		r.answers[URL.leaves] = async () => ({ ok: false, reason: "timeout" })
		await r.ask(URL.leaves, "leaves")
		r.at(5 * MIN)
		r.answers[URL.root] = async () => ({ ok: false, reason: "timeout" })
		r.answers[URL.leaves] = async () => leavesOf("2")
		await r.ask(URL.leaves, "leaves")
		r.at(10 * MIN)
		r.answers[URL.root] = async () => rootOf("1")
		r.answers[URL.leaves] = async () => leavesOf("1")
		expect(await text(r.ask(URL.leaves, "leaves")), "leaves fetched while the root failed stand for no root").toBe(
			await text(Promise.resolve(leavesOf("1"))),
		)
		expect(r.calls).toEqual({ [URL.root]: 3, [URL.leaves]: 3 })
	})

	test("a failure or a timeout uses its window, and every caller in it shares one request", async () => {
		const r = rig()
		let release = () => {}
		r.answers[URL.root] = () => new Promise((resolve) => (release = () => resolve({ ok: false, reason: "timeout" })))
		const waiting = Array.from({ length: 10 }, () => text(r.ask(URL.root, "root")))
		release()
		expect(await Promise.all(waiting)).toEqual(Array(10).fill("timeout"))
		r.at(5 * MIN - 1)
		expect(await text(r.ask(URL.root, "root"))).toBe("timeout")
		expect(r.calls[URL.root]).toBe(1)
		r.answers[URL.root] = () => Promise.reject(new Error("socket hang up"))
		r.at(5 * MIN)
		expect(await text(r.ask(URL.root, "root"))).toBe("socket hang up")
		expect(r.calls[URL.root]).toBe(2)
	})

	test("asks for the public key once an hour", async () => {
		const r = rig()
		for (const [t, calls] of [
			[0, 1],
			[5 * MIN, 1],
			[60 * MIN - 1, 1],
			[60 * MIN, 2],
		]) {
			r.at(t as number)
			await r.ask(URL.key, "public-key")
			expect(r.calls[URL.key], `at ${t} ms`).toBe(calls)
		}
	})

	test("refuses a URL past its fixed number without asking", async () => {
		const r = rig()
		for (let i = 0; i < MAX_URLS; i++) await r.ask(`${URL.snapshot}&n=${i}`, "snapshot")
		expect(await text(r.ask(URL.root, "root"))).toBe(`over ${MAX_URLS} ASP URLs`)
		expect(Object.values(r.calls).reduce((a, b) => a + b)).toBe(MAX_URLS)
	})
})
