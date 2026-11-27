/**
 * The fixture world behind `#data`: every port over one in-memory world whose clock is chain time,
 * moving only when a test advances it, as a local chain moves only with blocks.
 */
import { target } from "../../target"
import { stageManifest } from "../capabilities"
import type { DataSource } from "../source"
import { loadRealConnector } from "../wallet/load"
import { fixtureAllowList } from "./allow-list"
import { fixtureAztec } from "./aztec"
import { fixtureConnector } from "./connector"
import { createControl, type FixtureControl } from "./control"
import { fixtureExits } from "./exits"
import { fixtureL1 } from "./l1"
import { fixtureSessions } from "./session"
import { createWorld, type KeyValue } from "./world"

export type { FixtureControl } from "./control"
export type { KeyValue } from "./world"

/** Reading `sessionStorage` itself throws where site data is blocked. */
function sessionStore(): KeyValue | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage
	} catch {
		return null
	}
}

/** One world over `storage` (a reload is a second call over the same store) and the control that drives it. */
export function createFixtureSource(storage: KeyValue | null): { source: DataSource; control: FixtureControl } {
	const world = createWorld({ chainId: target.l1ChainId, storage })
	const l1 = fixtureL1(world)
	const manifest = stageManifest(world.deployment.stage, world.deployment)
	const wallet = fixtureConnector(world, manifest)
	const source: DataSource = {
		mode: "fixtures",
		deployment: world.deployment,
		clock: world.clock,
		timer: world.timer,
		l1,
		sessions: fixtureSessions(world, l1.provider),
		aztec: fixtureAztec(world),
		exits: fixtureExits(world),
		allowList: fixtureAllowList(world),
		wallet: () => (__PP_CONNECTOR__ === "real" ? loadRealConnector(manifest) : Promise.resolve(wallet)),
	}
	return { source, control: createControl(world, wallet) }
}

const page = createFixtureSource(sessionStore())

if (typeof window !== "undefined") window.__ppFixtures = page.control

/** The fixture world needs no chain read, so its source is ready at once. */
export const loadSource = (): Promise<DataSource> => Promise.resolve(page.source)
