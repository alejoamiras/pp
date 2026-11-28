/**
 * An Aztec node that answers `getNodeInfo` with a deployment file's rollup and refuses every other call:
 * enough for a CLI's node guard to pass so the check a case is about runs, and nothing past it can make
 * progress against this node.
 */
import type { TestnetDeployment } from "../schema"
import { eachCall, type LoopbackServer, serveJsonRpc } from "./loopback"

/** The method name aztec.js's node client sends for `getNodeInfo`. */
export const NODE_INFO = "aztec_getNodeInfo"

const ZERO = "0x0000000000000000000000000000000000000000"
const AZTEC_ZERO = `0x${"00".repeat(32)}`
const OTHER_L1 = ["feeJuice", "feeJuicePortal", "coinIssuer", "rewardDistributor", "governanceProposer", "governance", "stakingAsset"]

/** `getNodeInfo`'s answer for `n`'s rollup, which a CLI's node guard accepts. */
export const nodeInfo = (n: TestnetDeployment["network"]) => ({
	nodeVersion: "6.0.0",
	l1ChainId: n.l1ChainId,
	rollupVersion: n.rollupVersion,
	l1ContractAddresses: {
		rollupAddress: n.rollup,
		registryAddress: n.l1Registry,
		inboxAddress: n.inbox,
		outboxAddress: n.outbox,
		...Object.fromEntries(OTHER_L1.map((k) => [`${k}Address`, ZERO])),
	},
	protocolContractAddresses: {
		classRegistry: AZTEC_ZERO,
		feeJuice: AZTEC_ZERO,
		instanceRegistry: AZTEC_ZERO,
		multiCallEntrypoint: AZTEC_ZERO,
	},
	realProofs: false,
	txsLimits: { gas: { daGas: 0, l2Gas: 0 } },
})

type Call = { id: unknown; method: string }

/** Serves on `port` (already claimed) at 127.0.0.1; `calls` lists every method asked, in order. */
export async function startNodeStub(port: number, network: TestnetDeployment["network"]): Promise<LoopbackServer & { calls: string[] }> {
	const info = nodeInfo(network)
	const calls: string[] = []
	const server = await serveJsonRpc(
		port,
		eachCall((call: Call) => {
			calls.push(call.method)
			if (call.method === NODE_INFO) return { jsonrpc: "2.0", id: call.id, result: info }
			return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `this rehearsal node answers ${NODE_INFO} only` } }
		}),
	)
	return { ...server, calls }
}
