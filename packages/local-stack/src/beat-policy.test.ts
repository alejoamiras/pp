import { describe, expect, test } from "vitest"
import { BeatPolicy, type ChainView, type L1Tx } from "./beat-policy.ts"

const NODE: L1Tx = { from: "0xnode", to: "0xmulticall" }

/** A chain where every Aztec block is the node's propose block, then its empty proof block. */
function fakeChain() {
	const l1: { hash: string; txs: L1Tx[] }[] = []
	let minted = 0
	const l1Block = (txs: L1Tx[]) => l1.push({ hash: `0x${(minted++).toString(16)}`, txs })
	l1Block([])
	l1Block([{ from: "0xdeployer", to: null }])
	/** Whether each Aztec block carries transactions; the tip is the last index. */
	const aztec = [false, true, true, true, true]
	const aztecBlock = (hasTxs: boolean) => {
		l1Block([NODE])
		l1Block([])
		aztec.push(hasTxs)
	}
	const view: ChainView = {
		l1Head: async () => BigInt(l1.length - 1),
		l1Hash: async (n) => l1[Number(n)]?.hash ?? "",
		l1Txs: async (n) => l1[Number(n)]?.txs ?? [],
		aztecTip: async () => aztec.length - 1,
		aztecHasTxs: async (n) => aztec[n] ?? false,
	}
	return {
		view,
		/** What a beat's mine does; `hasTxs` when it picked up a pending user transaction. */
		mine: (hasTxs = false) => aztecBlock(hasTxs),
		l1Tx: (tx: L1Tx) => l1Block([tx]),
		foreignAztecBlock: () => aztecBlock(true),
		/** Drops the newest `depth` L1 blocks, as an anvil revert would. */
		revert: (depth: number) => l1.splice(-depth),
	}
}
type Chain = ReturnType<typeof fakeChain>

async function ticks(policy: BeatPolicy, chain: Chain, n: number, mine = () => chain.mine()): Promise<number> {
	let beats = 0
	for (let i = 0; i < n; i++) {
		if (!(await policy.due())) continue
		await policy.beat(async () => mine())
		beats++
	}
	return beats
}

/** A stack right after its readiness beat. */
async function booted(): Promise<{ chain: Chain; policy: BeatPolicy }> {
	const chain = fakeChain()
	chain.mine()
	const policy = new BeatPolicy(chain.view, NODE)
	await policy.start()
	return { chain, policy }
}

describe("beat policy", () => {
	test("after boot it owes one more beat, then an idle stack stays frozen", async () => {
		const { chain, policy } = await booted()
		expect(await ticks(policy, chain, 5)).toBe(1)
	})

	test("an L1 transaction other than the node's propose owes two beats, even from the node's account", async () => {
		const { chain, policy } = await booted()
		await ticks(policy, chain, 2)
		chain.l1Tx({ from: "0xuser", to: "0xinbox" })
		expect(await ticks(policy, chain, 1)).toBe(1)
		chain.l1Tx({ from: "0xuser", to: "0xinbox" })
		expect(await ticks(policy, chain, 5)).toBe(2)
		chain.l1Tx({ from: "0xnode", to: "0xinbox" })
		expect(await ticks(policy, chain, 5)).toBe(2)
	})

	test("an Aztec block the heartbeat did not mine owes one beat", async () => {
		const { chain, policy } = await booted()
		await ticks(policy, chain, 2)
		chain.foreignAztecBlock()
		expect(await ticks(policy, chain, 5)).toBe(1)
	})

	test("a last owed beat that picks up a user transaction, or that another block overtakes, owes one more", async () => {
		const { chain, policy } = await booted()
		await ticks(policy, chain, 2)
		let beats = 0
		const pickUp = () => chain.mine(beats++ === 0)
		chain.foreignAztecBlock()
		expect(await ticks(policy, chain, 5, pickUp)).toBe(2)
		beats = 0
		const overtaken = () => {
			chain.mine()
			if (beats++ === 0) chain.foreignAztecBlock()
		}
		chain.foreignAztecBlock()
		expect(await ticks(policy, chain, 5, overtaken)).toBe(2)
	})

	test("a revert that regrows to the scanned height still owes two beats", async () => {
		const { chain, policy } = await booted()
		await ticks(policy, chain, 2)
		chain.revert(1)
		chain.l1Tx({ from: "0xuser", to: "0xinbox" })
		expect(await ticks(policy, chain, 5)).toBe(2)
	})
})
