import { describe, expect, test } from "bun:test"
import { BeatPolicy, type ChainView, type L1Tx } from "./beat-policy.ts"

const NODE: L1Tx = { from: "0xnode", to: "0xmulticall" }

/** A chain where a beat mines the node's propose block, then its empty proof block. */
function fakeChain() {
	const l1: L1Tx[][] = [[], [{ from: "0xdeployer", to: null }]]
	let tip = 4
	const view: ChainView = {
		l1Head: async () => BigInt(l1.length - 1),
		l1Txs: async (n) => l1[Number(n)] ?? [],
		aztecTip: async () => tip,
	}
	return {
		view,
		beat: () => {
			l1.push([NODE], [])
			tip++
		},
		l1Tx: (tx: L1Tx) => l1.push([tx]),
		foreignAztecBlock: () => {
			l1.push([NODE], [])
			tip++
		},
	}
}

async function ticks(policy: BeatPolicy, chain: ReturnType<typeof fakeChain>, n: number): Promise<number> {
	let beats = 0
	for (let i = 0; i < n; i++) {
		if (!(await policy.due())) continue
		chain.beat()
		await policy.beaten()
		beats++
	}
	return beats
}

describe("beat policy", () => {
	test("after boot it owes one more beat, then an idle stack stays frozen", async () => {
		const chain = fakeChain()
		chain.beat()
		const policy = new BeatPolicy(chain.view, NODE)
		await policy.start()
		expect(await ticks(policy, chain, 5)).toBe(1)
	})

	test("an L1 transaction other than the node's propose owes two beats, even from the node's account", async () => {
		const chain = fakeChain()
		chain.beat()
		const policy = new BeatPolicy(chain.view, NODE)
		await policy.start()
		await ticks(policy, chain, 2)
		chain.l1Tx({ from: "0xuser", to: "0xinbox" })
		expect(await ticks(policy, chain, 1)).toBe(1)
		chain.l1Tx({ from: "0xuser", to: "0xinbox" })
		expect(await ticks(policy, chain, 5)).toBe(2)
		chain.l1Tx({ from: "0xnode", to: "0xinbox" })
		expect(await ticks(policy, chain, 5)).toBe(2)
	})

	test("an Aztec block the heartbeat did not mine owes one beat", async () => {
		const chain = fakeChain()
		chain.beat()
		const policy = new BeatPolicy(chain.view, NODE)
		await policy.start()
		await ticks(policy, chain, 2)
		chain.foreignAztecBlock()
		expect(await ticks(policy, chain, 5)).toBe(1)
	})
})
