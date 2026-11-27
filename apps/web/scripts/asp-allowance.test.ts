import { describe, expect, test } from "vitest"
import { aspAllowance, MAX_URLS, PUBLIC_KEY_MS, WINDOW_MS } from "./asp-allowance"
import type { Forwarded } from "./proxy"

const ASP = "https://asp.example"
const SCOPE = `chainId=11155111&entrypoint=0x${"11".repeat(20)}`
const URL = {
	root: `${ASP}/association-set/root?${SCOPE}`,
	leaves: `${ASP}/association-set/leaves?${SCOPE}`,
	key: `${ASP}/public-key`,
	snapshot: `${ASP}/11155111/public/event-snapshot/payload?entrypoint=0x${"11".repeat(20)}`,
}

const ok = (text: string): Forwarded => ({ ok: true, status: 200, body: new TextEncoder().encode(text) })

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
		r.answers[URL.root] = async () => ok('{"root":"7"}')
		const poll = async () => {
			await r.ask(URL.root, "root")
			await r.ask(URL.leaves, "leaves")
			await r.ask(URL.key, "public-key")
			await r.ask(URL.snapshot, "snapshot")
		}
		for (let t = 0; t < 10 * 60_000; t += 6_000) {
			r.at(t)
			await Promise.all(Array.from({ length: 5 }, poll))
		}
		expect(r.calls).toEqual({ [URL.root]: 2, [URL.leaves]: 1, [URL.key]: 1, [URL.snapshot]: 2 })
	})

	test("asks for the leaves again once the root answer changes, but not within five minutes of the last ask", async () => {
		const r = rig()
		let root = "A"
		r.answers[URL.root] = async () => ok(root)
		r.answers[URL.leaves] = async () => ok(`leaves under ${root}`)
		await r.ask(URL.root, "root")
		r.at(60_000)
		expect(await text(r.ask(URL.leaves, "leaves"))).toBe("leaves under A")
		root = "B"
		r.at(WINDOW_MS)
		await r.ask(URL.root, "root")
		expect(await text(r.ask(URL.leaves, "leaves")), "inside the leaves' window").toBe("leaves under A")
		r.at(60_000 + WINDOW_MS)
		expect(await text(r.ask(URL.leaves, "leaves"))).toBe("leaves under B")
		expect(r.calls[URL.leaves]).toBe(2)
	})

	test("a failure or a timeout uses its window, and every caller in it shares one request", async () => {
		const r = rig()
		let release = () => {}
		r.answers[URL.root] = () => new Promise((resolve) => (release = () => resolve({ ok: false, reason: "timeout" })))
		const waiting = Array.from({ length: 10 }, () => text(r.ask(URL.root, "root")))
		release()
		expect(await Promise.all(waiting)).toEqual(Array(10).fill("timeout"))
		r.at(WINDOW_MS - 1)
		expect(await text(r.ask(URL.root, "root"))).toBe("timeout")
		expect(r.calls[URL.root]).toBe(1)
		r.answers[URL.root] = () => Promise.reject(new Error("socket hang up"))
		r.at(WINDOW_MS)
		expect(await text(r.ask(URL.root, "root"))).toBe("socket hang up")
		expect(r.calls[URL.root]).toBe(2)
	})

	test("asks for the public key once an hour", async () => {
		const r = rig()
		for (const t of [0, WINDOW_MS, PUBLIC_KEY_MS - 1, PUBLIC_KEY_MS]) {
			r.at(t)
			await r.ask(URL.key, "public-key")
		}
		expect(r.calls[URL.key]).toBe(2)
	})

	test("refuses a URL past its fixed number without asking", async () => {
		const r = rig()
		for (let i = 0; i < MAX_URLS; i++) await r.ask(`${URL.snapshot}&n=${i}`, "snapshot")
		expect(await text(r.ask(URL.root, "root"))).toBe(`over ${MAX_URLS} ASP URLs`)
		expect(Object.values(r.calls).reduce((a, b) => a + b)).toBe(MAX_URLS)
	})
})
