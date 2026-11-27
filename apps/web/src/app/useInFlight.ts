import { useMemo, useReducer, useRef } from "react"

/** Sends still in flight by key, held above the rows that start them: a row that remounts mid-send must not send again. */
export interface InFlight {
	has(key: string): boolean
	/** Runs `send` unless `key` is already in flight; resolves `false` when it was. */
	run(key: string, send: () => Promise<void>): Promise<boolean>
}

export function useInFlight(): InFlight {
	const held = useRef(new Set<string>())
	const [, rerender] = useReducer((n: number) => n + 1, 0)
	return useMemo(
		() => ({
			has: (key) => held.current.has(key),
			async run(key, send) {
				if (held.current.has(key)) return false
				held.current.add(key)
				rerender()
				try {
					await send()
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
