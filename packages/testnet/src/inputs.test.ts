import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { encodeAbiParameters, type PublicClient } from "viem"
import { describe, expect, it } from "vitest"
import { checkForge, probeL1, probeNode, resolveForge } from "./inputs"
import { parseDeployment } from "./schema"
import { scratchHome } from "./test-support"

const own = parseDeployment(JSON.parse(readFileSync(fileURLToPath(new URL("../deployments/testnet-own.json", import.meta.url)), "utf8")))

describe("the forge binary", () => {
	it("prefers PP_FORGE, else walks PATH, and refuses a binary that is not the committed release", () => {
		const dir = join(scratchHome(), "bin")
		mkdirSync(dir)
		const fake = join(dir, "forge")
		writeFileSync(fake, "#!/bin/sh\necho 'forge Version: 1.7.1'\n")
		chmodSync(fake, 0o755)
		expect(resolveForge({ PP_FORGE: "/elsewhere/forge", PATH: dir })).toBe("/elsewhere/forge")
		expect(resolveForge({ PATH: `/nonexistent:${dir}` })).toBe(fake)
		expect(checkForge(fake)).toMatchObject({
			ok: false,
			detail: expect.stringMatching(/has sha256 [0-9a-f]{64}, the committed forge Version: 1\.7\.1/),
		})
		expect(checkForge(undefined)).toMatchObject({ ok: false, detail: "no forge on PATH and PP_FORGE unset" })
	})
})

const HASH = `0x${"ab".repeat(32)}` as const

function fakeL1(rollup: string, calls: unknown[]) {
	return {
		getBlockNumber: async () => 1_000_000n,
		getLogs: async (a: unknown) => {
			calls.push(["logs", a])
			return []
		},
		getBlock: async (a: { blockNumber?: bigint; blockTag?: string }) =>
			a.blockTag === "finalized" ? { number: 999_900n, hash: HASH } : { number: a.blockNumber, hash: HASH },
		request: async (a: unknown) => {
			calls.push(["call", a])
			return encodeAbiParameters([{ type: "address" }], [rollup as `0x${string}`])
		},
	} as unknown as PublicClient
}

describe("the endpoint probes", () => {
	it("L1: asks for 10,000 blocks of logs ending five behind head and calls by canonical block hash", async () => {
		const calls: unknown[] = []
		expect(await probeL1(fakeL1(own.network.rollup, calls), own)).toMatchObject({ ok: true })
		expect(calls).toEqual([
			["logs", { address: own.network.inbox, fromBlock: 989_996n, toBlock: 999_995n }],
			["call", expect.objectContaining({ params: [expect.anything(), { blockHash: HASH, requireCanonical: true }] })],
		])
		expect(await probeL1(fakeL1("0x000000000000000000000000000000000000dEaD", []), own)).toMatchObject({
			ok: false,
			detail: expect.stringMatching(/canonical rollup is 0x0+dEaD/i),
		})
	})

	it("Aztec node: reads the latest block back by its hash and storage at it; a different block fails", async () => {
		const block = (hash: string) => ({ blockHash: { toString: () => hash }, header: { globalVariables: { blockNumber: 7 } } })
		const reads: unknown[] = []
		const node = (byHash: string) => ({
			getBlockData: async (p: unknown) => (p === "latest" ? block("0x01") : block(byHash)),
			getPublicStorageAt: async (b: unknown) => {
				reads.push(b)
				return { toString: () => "0x0" } as never
			},
		})
		expect(await probeNode(node("0x01"), own)).toMatchObject({ ok: true })
		expect(reads).toHaveLength(1)
		expect(await probeNode(node("0x02"), own)).toMatchObject({ ok: false, detail: expect.stringMatching(/came back as 0x02/) })
	})
})
