/** The ASP root registry on a live network, posted by the suite itself, and the label trees it posts. */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { L2Base } from "@pp/bridge-core/sandbox"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import { aspLeaf, buildLeanImt } from "@pp/bridge-spec"
import { type Device, deployOpts, sendOpts } from "./token"

/** The `LabelPath` argument of a checked spend. */
export interface PathArg {
	index: number
	depth: number
	siblings: bigint[]
}

export interface Tree {
	root: bigint
	path(label: bigint): PathArg
}

/** A LeanIMT of `labels` built by @pp/bridge-spec, so every spend checks a TS path in the circuit. */
export function tree(labels: bigint[]): Tree {
	const imt = buildLeanImt(labels.map(aspLeaf))
	return {
		root: imt.root,
		path: (label) => {
			const i = labels.indexOf(label)
			if (i < 0) throw new Error(`label ${label.toString(16)} is not in this tree`)
			const p = imt.path(i)
			return { index: p.index, depth: p.depth, siblings: [...p.siblings] }
		},
	}
}

export interface Registry {
	address: AztecAddress
	/**
	 * Posts both roots, observed at the latest block. The post lands in a later block, so its
	 * `root_time` precedes every anchor that sees it. Re-posting unchanged roots is the heartbeat that
	 * renews their freshness: local time moves only with blocks, about 72 s each. Returns the
	 * `root_time` posted.
	 */
	post(pool: bigint, birth: bigint): Promise<bigint>
}

/** Deploys a registry with `d` as its admin, poster and birth intake. */
export async function deployRegistry(d: Device, node: L2Base["node"]): Promise<Registry> {
	const { contract } = await Contract.deploy(d.wallet, aspRootRegistryArtifact, [d.from, d.from, d.from]).send(deployOpts(d) as never)
	let sequence = 0n
	return {
		address: contract.address,
		async post(pool, birth) {
			const head = await node.getBlockData("latest")
			if (!head) throw new Error("the node has no latest block")
			sequence += 1n
			const rootTime = head.header.globalVariables.timestamp
			// The sequence doubles as the L1 block, which must rise whenever the time does.
			await contract.methods.post_root(sequence, pool, birth, sequence, rootTime).send(sendOpts(d) as never)
			return rootTime
		},
	}
}
