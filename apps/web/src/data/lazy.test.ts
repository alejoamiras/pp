import { describe, expect, test, vi } from "vitest"
import { BridgeFailure, codeOf } from "./errors"
import { importChunk, loadOnce } from "./lazy"
import { connectErrorMessage } from "./wallet/types"

describe("loadOnce", () => {
	test("shares a running load and keeps a resolved one", async () => {
		let resolve: (v: number) => void = () => {}
		const load = vi.fn(() => new Promise<number>((r) => (resolve = r)))
		const get = loadOnce(load)
		const [a, b] = [get(), get()]
		resolve(7)
		expect(await Promise.all([a, b, get()])).toEqual([7, 7, 7])
		expect(load).toHaveBeenCalledTimes(1)
	})

	test("drops a rejected load, so the next call loads again", async () => {
		const failed = new Error("chunk")
		const load = vi.fn<() => Promise<number>>().mockRejectedValueOnce(failed).mockResolvedValueOnce(7)
		const get = loadOnce(load)
		const [a, b] = [get(), get()]
		await expect(a).rejects.toBe(failed)
		await expect(b).rejects.toBe(failed)
		expect(await get()).toBe(7)
		expect(await get()).toBe(7)
		expect(load).toHaveBeenCalledTimes(2)
	})
})

describe("importChunk", () => {
	test("a failed import reads PAGE_LOAD_FAILED whatever the browser's message", async () => {
		for (const message of ["Failed to fetch dynamically imported module: /a.js", "error loading dynamically imported module", ""]) {
			const err = await importChunk(Promise.reject(new TypeError(message))).catch((e: unknown) => e)
			expect(codeOf(err)).toBe("PAGE_LOAD_FAILED")
		}
	})

	test("a failure of the step after the import keeps its own error", async () => {
		const own = new BridgeFailure("DEPLOYMENT_MISMATCH")
		const built = importChunk(Promise.resolve({ build: () => 1 })).then(() => {
			throw own
		})
		await expect(built).rejects.toBe(own)
	})

	test("connecting shows the page's own sentence for a chunk that failed to load", async () => {
		const err = await importChunk(Promise.reject(new TypeError("Failed to fetch"))).catch((e: unknown) => e)
		expect(connectErrorMessage(err)).toBe("A part of this page failed to load. Reload the page.")
		expect(connectErrorMessage(new TypeError("Failed to fetch"))).toBe("Something went wrong while connecting. Try again.")
	})
})
