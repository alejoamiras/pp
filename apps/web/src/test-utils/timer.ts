import type { Timer } from "../data/ports"

/** A timer that moves only on `advance`; aborting a sleep resolves it `false`. */
export function virtualTimer(): Timer & { advance(ms: number): void } {
	let t = 0
	const sleeps = new Set<{ due: number; done: (elapsed: boolean) => void }>()
	return {
		now: () => t,
		sleep(ms, signal) {
			return new Promise<boolean>((resolve) => {
				const entry = { due: t + ms, done: resolve }
				sleeps.add(entry)
				signal?.addEventListener("abort", () => sleeps.delete(entry) && resolve(false), { once: true })
			})
		},
		advance(ms) {
			t += ms
			for (const s of [...sleeps]) if (s.due <= t) sleeps.delete(s) && s.done(true)
		},
	}
}
