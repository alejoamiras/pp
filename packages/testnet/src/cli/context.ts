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
 * The own pool's deployer and mock ASP exist only on the own target; an operator's pool and ASP are the operator's.
 * @throws GuardError `operator`
 */
export function assertOwnPool(d: TestnetDeployment): void {
	if (d.target !== "own")
		throw new GuardError("operator", `target ${d.target} uses the operator's pool and ASP; this command serves the own pool`)
}
