import { describe, expect, test } from "vitest"
import { virtualTimer } from "../../test-utils/timer"
import { downloadSnapshot, MAX_SNAPSHOT_BYTES } from "./snapshot-download"

const LIMITS = { maxBytes: 10, idleMs: 1_000, totalMs: 5_000 }
const bytes = (n: number) => new Uint8Array(n).fill(0x31)

/** A body the test feeds chunk by chunk, and whether the reader cancelled it. */
function feed() {
	let controller!: ReadableStreamDefaultController<Uint8Array>
	let cancelled = false
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
		},
		cancel() {
			cancelled = true
		},
	})
	return { body, push: (chunk: Uint8Array) => controller.enqueue(chunk), end: () => controller.close(), cancelled: () => cancelled }
}

const serving = (res: () => Response): typeof fetch => (async () => res()) as typeof fetch
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("the snapshot download", () => {
	test("the canonical maximal list fits the cap", () => {
		// 2 * 2^18 leaves of 80 bytes is 41,943,040; the keys, both roots and a u64 sequence take 249 more.
		expect(MAX_SNAPSHOT_BYTES - 41_943_040 - 249).toBeGreaterThanOrEqual(0)
		expect(MAX_SNAPSHOT_BYTES - 41_943_040 - 249).toBeLessThan(1024)
	})

	test("refuses a body past the cap by the bytes it reads, whatever its Content-Length says", async () => {
		const f = feed()
		const res = new Response(f.body, { headers: { "content-length": "4" } })
		const download = downloadSnapshot("http://bot/v1/snapshots/7", { fetch: serving(() => res), timer: virtualTimer(), limits: LIMITS })
		f.push(bytes(6))
		f.push(bytes(5))
		await expect(download).rejects.toMatchObject({ code: "LIST_OVERSIZED" })
		expect(f.cancelled()).toBe(true)
	})

	test("times out on a silence between chunks and on a body that never ends, and reads a 404 as no snapshot", async () => {
		const timer = virtualTimer()
		const silent = feed()
		const stalled = downloadSnapshot("http://bot/v1/snapshots/7", {
			fetch: serving(() => new Response(silent.body)),
			timer,
			limits: LIMITS,
		})
		silent.push(bytes(1))
		await flush()
		timer.advance(LIMITS.idleMs)
		await expect(stalled).rejects.toMatchObject({ code: "LIST_TIMEOUT" })

		const dripping = feed()
		const slow = downloadSnapshot("http://bot/v1/snapshots/7", {
			fetch: serving(() => new Response(dripping.body)),
			timer,
			limits: LIMITS,
		})
		for (let i = 0; i < 6; i++) {
			dripping.push(bytes(1))
			await flush()
			timer.advance(LIMITS.idleMs - 1)
		}
		await expect(slow).rejects.toMatchObject({ code: "LIST_TIMEOUT" })

		const missing = serving(() => new Response(null, { status: 404 }))
		await expect(downloadSnapshot("http://bot/v1/snapshots/7", { fetch: missing, timer, limits: LIMITS })).resolves.toBeNull()
		const done = feed()
		const whole = downloadSnapshot("http://bot/v1/snapshots/7", {
			fetch: serving(() => new Response(done.body)),
			timer,
			limits: LIMITS,
		})
		done.push(new TextEncoder().encode("{}"))
		done.end()
		await expect(whole).resolves.toBe("{}")
	})

	test("cancels the body of a failed answer, which would otherwise keep streaming outside the limits", async () => {
		const failing = feed()
		const unavailable = downloadSnapshot("http://bot/v1/snapshots/7", {
			fetch: serving(() => new Response(failing.body, { status: 503 })),
			timer: virtualTimer(),
			limits: LIMITS,
		})
		await expect(unavailable).rejects.toMatchObject({ code: "LIST_UNAVAILABLE" })
		await flush()
		expect(failing.cancelled()).toBe(true)
	})
})
