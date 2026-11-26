/**
 * The fixture world behind `#data`. Its clock is chain time, never the browser's: it moves only when
 * a test advances it, as a local chain moves only with blocks.
 */
import type { DataSource } from "../source"
import { loadRealConnector } from "../wallet/load"
import { fixtureConnector } from "./connector"

/** 2026-01-01T00:00:00Z, an arbitrary genesis for both chains. */
const GENESIS = 1_767_225_600n
const L1_BLOCK_SECONDS = 12n

const world = { l1Blocks: 0n }
const now = () => GENESIS + world.l1Blocks * L1_BLOCK_SECONDS

export interface FixtureControl {
	/** Moves L1 by `blocks` blocks; chain time moves with it. */
	advance(blocks: number): void
	state(): { l1Time: string }
}

const control: FixtureControl = {
	advance(blocks) {
		if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error("__ppFixtures.advance: blocks must be a non-negative integer")
		world.l1Blocks += BigInt(blocks)
	},
	state: () => ({ l1Time: now().toString() }),
}

if (typeof window !== "undefined") window.__ppFixtures = control

export const source: DataSource = {
	mode: "fixtures",
	clock: { aztecNow: async () => now(), l1Now: async () => now() },
	wallet: () => (__PP_CONNECTOR__ === "real" ? loadRealConnector() : Promise.resolve(fixtureConnector())),
}
