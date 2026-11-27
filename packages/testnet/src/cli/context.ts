import type { GuardianL1, OpenContext } from "@pp/bridge-core/deploy"
import type { PublicClient } from "viem"
import { GuardError } from "../guards"
import type { TestnetDeployment } from "../schema"

type Full = TestnetDeployment & Required<Pick<TestnetDeployment, "expected" | "pool" | "bridge">>

/**
 * `checkBeforeOpen`'s context from the file alone: every expectation comes from `network` and the
 * committed `expected`, never from the deployed contracts.
 */
export function openContextOf(d: Full, l1: PublicClient, node: unknown): OpenContext & { l1: GuardianL1 } {
	return {
		chainId: d.network.l1ChainId,
		l1: l1 as unknown as GuardianL1,
		node: node as OpenContext["node"],
		factory: d.bridge.factory,
		portals: [{ asset: d.pool.asset, portal: d.bridge.portal, l2Token: d.bridge.token }],
		hub: d.bridge.hub,
		registry: d.bridge.registry,
		expected: {
			guardian: d.expected.guardian,
			lifetimeCap: d.expected.lifetimeCap,
			pool: d.pool.poolVault,
			rollup: {
				l1Registry: d.network.l1Registry,
				rollup: d.network.rollup,
				inbox: d.network.inbox,
				outbox: d.network.outbox,
				rollupVersion: BigInt(d.network.rollupVersion),
			},
			registryRoles: { admin: d.expected.l2Deployer, poster: d.expected.botPoster, birthIntake: d.expected.birthIntake },
		},
	}
}

/**
 * Operator targets re-read their pool against `operator` before any signature. Until that adaptation
 * lands with the operator pass, a CLI that signs on one refuses.
 * @throws GuardError `operator`
 */
export function assertOwnTarget(d: TestnetDeployment): void {
	if (d.target !== "own")
		throw new GuardError("operator", `target ${d.target} needs the operator checks, which this build does not have yet`)
}
