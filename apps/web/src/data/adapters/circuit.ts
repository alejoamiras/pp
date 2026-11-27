import { PINNED_CIRCUITS, type PinnedCircuit } from "@pp/pool-client/circuits"

/** The one circuit the app proves, pool-client's one-input spend; the pinned bundle also holds circuits it never runs. */
export const PROVED_CIRCUIT = "transact_1x1"

/** Its pins: the only proving files the page fetches and `serve` hands out. */
export const PROVED_PINS: PinnedCircuit = (() => {
	const pin = PINNED_CIRCUITS[PROVED_CIRCUIT]
	if (!pin) throw new Error(`pool-client pins no ${PROVED_CIRCUIT} circuit`)
	return pin
})()
