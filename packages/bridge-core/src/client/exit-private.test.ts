import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { BN254_P, type LabelPath } from "@pp/bridge-spec"
import vectors from "@pp/bridge-spec/vectors/v1.json" with { type: "json" }
import { type Address, getAddress, toHex } from "viem"
import { beforeAll, describe, expect, it } from "vitest"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../artifacts"
import { DEPLOYMENT, HUB, PORTAL } from "../test/client-fakes"
import type { ClientDeployment } from "./deployment"
import { type ExitPrivateNode, exitPrivatePayload } from "./exit-private"
import { sponsoredFpcAddress } from "./payload"

const TOKEN = toHex(7n, { size: 32 })
const REGISTRY = 0x9e9n
const D: ClientDeployment = { ...DEPLOYMENT, token: TOKEN, outbox: "0x00000000000000000000000000000000000000b4" }
const OUT = vectors.out[0]!
const LABEL = 0x1abe1n
const PATH: LabelPath = { index: 1, depth: 1, siblings: [5n, ...Array<bigint>(17).fill(0n)] }

const payeeOf = (word: string): Address => {
	const v = BigInt(word)
	return `0x${v.toString(16).padStart(v < 2n ** 160n ? 40 : 42, "0")}`
}

let classes: { hub: string; token: string }
beforeAll(async () => {
	classes = {
		hub: (await getContractClassFromArtifact(tokenBridgeHubArtifact)).id.toString(),
		token: (await getContractClassFromArtifact(labelledTokenArtifact)).id.toString(),
	}
})

/** A node serving the hub, the token and the registry at the given classes; absent means no instance. */
function node(o: { hub?: string | null; token?: string | null; registry?: bigint; registryDeployed?: boolean } = {}): ExitPrivateNode {
	const registry = o.registry ?? REGISTRY
	const served = new Map<bigint, string | null>([
		[BigInt(HUB), o.hub === undefined ? classes.hub : o.hub],
		[BigInt(TOKEN), o.token === undefined ? classes.token : o.token],
		[registry, o.registryDeployed === false ? null : "0x01"],
	])
	return {
		getContract: async (address) => {
			const cls = served.get(BigInt(address.toString())) ?? null
			return (cls === null ? undefined : { address, currentContractClassId: { toString: () => cls } }) as never
		},
		getPublicStorageAt: async (_block, contract) => new Fr(BigInt(contract.toString()) === BigInt(HUB) ? registry : 0n),
	}
}

const request = (over: Partial<Parameters<typeof exitPrivatePayload>[1]> = {}) => ({
	payee: getAddress(OUT.payee),
	amount: BigInt(OUT.amount),
	label: LABEL,
	path: PATH,
	...over,
})

describe("exitPrivatePayload", () => {
	it("calls the hub's exit_private for the deployment's token, with the label and path, paid by the SponsoredFPC", async () => {
		const p = await exitPrivatePayload({ deployment: D, node: node() }, request())
		const call = p.calls.find((x) => x.name === "exit_private")
		expect(call?.to.toString()).toBe(HUB)
		expect(call?.args.map((a) => a.toBigInt())).toEqual([
			BigInt(TOKEN),
			BigInt(OUT.payee),
			BigInt(OUT.amount),
			LABEL,
			1n,
			1n,
			...PATH.siblings,
		])
		expect(p.feePayer?.equals(await sponsoredFpcAddress())).toBe(true)
	})

	const refused = vectors.rejections
		.filter((r) => r.fn === "exitContent")
		.map((r) => [r.name, { payee: payeeOf(r.args.payee!), amount: BigInt(r.args.amount!) }, r.error] as const)
	const deep: LabelPath = { index: 0, depth: 19, siblings: Array<bigint>(18).fill(0n) }
	it.each([
		...refused,
		["the portal as payee", { payee: PORTAL }, "PayeeIsPortal"] as const,
		[
			"a mixed-case payee whose checksum fails",
			{ payee: "0x000000000000000000000000000000000000BeeF" as Address },
			"PayeeChecksum",
		] as const,
		["label 0", { label: 0n }, "LabelOutOfRange"] as const,
		["a label of p", { label: BN254_P }, "LabelOutOfRange"] as const,
		["a path deeper than 18", { path: deep }, "DepthOutOfRange"] as const,
		["an index bit at or above the depth", { path: { ...PATH, index: 2 } }, "IndexOutOfRange"] as const,
		[
			"a sibling above the depth",
			{ path: { ...PATH, siblings: [5n, 6n, ...Array<bigint>(16).fill(0n)] } },
			"SiblingOutOfRange",
		] as const,
		["a path without 18 siblings", { path: { ...PATH, siblings: [5n] } }, "SiblingOutOfRange"] as const,
	])("refuses %s before reading the deployment", async (_, over, source) => {
		const reads = { n: 0 }
		const counted: ExitPrivateNode = {
			getContract: async () => {
				reads.n++
				return undefined
			},
			getPublicStorageAt: async () => {
				reads.n++
				return Fr.ZERO
			},
		}
		await expect(exitPrivatePayload({ deployment: D, node: counted }, request(over))).rejects.toMatchObject({
			code: "SPEND_MISMATCH",
			source,
		})
		expect(reads.n).toBe(0)
	})

	it.each([
		["a hub of another class (an older generation)", { hub: "0x2a" }, "HubClass"],
		["a token of another class", { token: "0x2b" }, "TokenClass"],
		["a hub without a registry", { registry: 0n }, "NoRegistry"],
		["a registry address with no contract", { registryDeployed: false }, "NoRegistry"],
	] as const)("answers STAGE_UNSUPPORTED for %s", async (_, o, source) => {
		await expect(exitPrivatePayload({ deployment: D, node: node(o) }, request())).rejects.toMatchObject({
			code: "STAGE_UNSUPPORTED",
			source,
		})
	})

	it.each([
		["hub", { hub: null }],
		["token", { token: null }],
	] as const)("answers DEPLOYMENT_MISMATCH when the node has no %s instance", async (_, o) => {
		await expect(exitPrivatePayload({ deployment: D, node: node(o) }, request())).rejects.toMatchObject({
			code: "DEPLOYMENT_MISMATCH",
		})
	})
})
