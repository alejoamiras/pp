import { useMemo, useReducer, useRef } from "react"

/**
 * Sends still in flight by key, and the last one's failure, held above the rows that start them: a
 * row that remounts mid-send must neither send again nor lose what the send answered.
 */
export interface InFlight<F> {
	has(key: string): boolean
	/** The last finished run's failure for `key`, until the next run of it starts. */
	failure(key: string): F | undefined
	/** Runs `send` unless `key` is already in flight; resolves `false` when it was. `send` answers its failure, if any. */
	run(key: string, send: () => Promise<F | undefined>): Promise<boolean>
}

export function useInFlight<F>(): InFlight<F> {
	const held = useRef(new Set<string>())
	const failed = useRef(new Map<string, F>())
	const [, rerender] = useReducer((n: number) => n + 1, 0)
	return useMemo(
		() => ({
			has: (key) => held.current.has(key),
			failure: (key) => failed.current.get(key),
			async run(key, send) {
				if (held.current.has(key)) return false
				held.current.add(key)
				failed.current.delete(key)
				rerender()
				try {
					const f = await send()
					if (f !== undefined) failed.current.set(key, f)
					return true
				} finally {
					held.current.delete(key)
					rerender()
				}
			},
		}),
		[],
	)
}
