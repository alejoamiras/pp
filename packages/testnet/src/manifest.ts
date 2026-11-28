import { parseStackManifest, type StackManifest } from "@pp/bridge-core"
import { loopback } from "./network"
import { requireSections, type TestnetDeployment } from "./schema"

/**
 * The stack manifest the client and the bot read, built in memory and never stored: the file stays the
 * one record. The bot block appears once `expected` names its accounts.
 * @throws Error when the file has no pool or bridge yet, or the projection fails the manifest's strict schema
 */
export function toStackManifest(file: TestnetDeployment): StackManifest {
	const d = requireSections(file, ["pool", "bridge"])
	const { factoryTx: _, ...bridge } = d.bridge
	// The own pool's code-check fields are not part of a stack manifest's strict pool block.
	const { accessRouter: _router, relay: _relay, ...pool } = d.pool
	return parseStackManifest(
		JSON.parse(
			JSON.stringify(
				{
					version: 1,
					chainId: d.network.l1ChainId,
					l1Rpc: d.network.l1Rpc,
					aztecNode: d.network.aztecNode,
					pool,
					bridge,
					...(d.expected
						? { bot: { url: loopback(d.network.botPort), poster: d.expected.botPoster, birthIntake: d.expected.birthIntake } }
						: {}),
				},
				(_k, v) => (typeof v === "bigint" ? v.toString() : v),
			),
		),
	)
}
