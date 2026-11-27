import type { Timer } from "./ports"

/** The page's monotonic clock; never `Date.now()`, which jumps when the system clock is set. */
export const browserTimer: Timer = {
	now: () => performance.now(),
	sleep: (ms, signal) =>
		new Promise<boolean>((resolve) => {
			if (signal?.aborted) return resolve(false)
			const id = setTimeout(() => resolve(true), ms)
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(id)
					resolve(false)
				},
				{ once: true },
			)
		}),
}

/** Resolves after the next paint, so text set before it is on screen before a main-thread stall. */
export const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
