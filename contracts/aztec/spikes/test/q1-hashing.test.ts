import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Actor, actor, artifact, record, summarizeProfile } from "./helpers"

interface Membership {
	name: string
	label: string
	root: string
	depth: number
	index: number
	siblings: string[]
}

const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "..", "vectors", "vectors.json"), "utf8")) as {
	memberships: Membership[]
}
const deep = vectors.memberships.find((m) => m.name === "deep_first") as Membership
const padded = [...deep.siblings, ...Array(18 - deep.siblings.length).fill("0x0")]

describe("q1 hashing: real client proofs", () => {
	let alice: Actor
	let spike: Contract

	beforeAll(async () => {
		alice = await actor(inject("nodeUrl"), 0, { proverEnabled: true })
		const deployed = await Contract.deploy(alice.wallet, artifact("poseidon_spike-PoseidonSpike.json"), []).send({ from: alice.address })
		spike = deployed.contract
	})
	afterAll(async () => {
		await alice?.wallet.stop()
	})

	it("proves a depth-18 ASP membership with the real prover", async () => {
		const call = spike.methods.asp_member(deep.label, deep.root, deep.depth, deep.index, padded)
		const profile = await call.profile({ from: alice.address, profileMode: "full", skipProofGeneration: false })
		const summary = summarizeProfile(profile)
		record("q1.asp_member_depth18.tx", summary)
		expect(summary.provingMs).toBeGreaterThan(0)
		expect(summary.steps.some((s) => s.fn.includes("asp_member"))).toBe(true)
	})

	it("proves the empty private function with the real prover (baseline)", async () => {
		const profile = await spike.methods.baseline().profile({ from: alice.address, profileMode: "full", skipProofGeneration: false })
		const summary = summarizeProfile(profile)
		record("q1.baseline.tx", summary)
		expect(summary.provingMs).toBeGreaterThan(0)
	})

	it("lands a proven depth-18 membership transaction", async () => {
		const { receipt } = await spike.methods
			.asp_member(deep.label, deep.root, deep.depth, deep.index, padded)
			.send({ from: alice.address })
		expect(receipt.hasExecutionSucceeded()).toBe(true)
	})
})
