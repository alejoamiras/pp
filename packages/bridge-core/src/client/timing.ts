/** How long an L1 receipt wait may take and how often a client polls. */
export type ClientTiming = { readonly receiptTimeoutMs: number; readonly pollingIntervalMs: number }

/** A local chain's: blocks every second or so, so a receipt is due within two minutes. */
export const LOCAL_TIMING: ClientTiming = Object.freeze({ receiptTimeoutMs: 120_000, pollingIntervalMs: 1_000 })

/** A public chain's: 12 s slots, fee spikes and load-balanced endpoints. */
export const PUBLIC_CHAIN_TIMING: ClientTiming = Object.freeze({ receiptTimeoutMs: 600_000, pollingIntervalMs: 4_000 })

/**
 * A validated, frozen copy, so a caller cannot change a client's timing after construction.
 * @throws RangeError when either value is not a positive finite number.
 */
export function clientTiming(t: ClientTiming = LOCAL_TIMING): ClientTiming {
	for (const [name, v] of Object.entries({ receiptTimeoutMs: t.receiptTimeoutMs, pollingIntervalMs: t.pollingIntervalMs }))
		if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
			throw new RangeError(`${name} must be a positive finite number, got ${v}`)
	return Object.freeze({ receiptTimeoutMs: t.receiptTimeoutMs, pollingIntervalMs: t.pollingIntervalMs })
}
