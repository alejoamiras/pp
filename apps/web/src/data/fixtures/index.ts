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
import { createControl } from "./control"
import { fixtureExits } from "./exits"
import { fixtureL1 } from "./l1"
import { fixtureSessions } from "./session"
import { createWorld, type KeyValue } from "./world"

export type { FixtureControl } from "./control"

/** Reading `sessionStorage` itself throws where site data is blocked. */
function sessionStore(): KeyValue | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage
	} catch {
		return null
	}
}

const world = createWorld({ chainId: target.l1ChainId, storage: sessionStore() })
const l1 = fixtureL1(world)
const manifest = stageManifest(world.deployment.stage, world.deployment)
const wallet = fixtureConnector(world, manifest)

if (typeof window !== "undefined") window.__ppFixtures = createControl(world, wallet)

export const source: DataSource = {
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
