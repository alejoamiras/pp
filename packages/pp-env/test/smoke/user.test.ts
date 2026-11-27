import { expect, test } from "bun:test"
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createWalletClient, getAddress, http, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { secretDerivationTypedData } from "../../src/client/derivation.ts"
import { createPoolUser, snapshot } from "../../src/client/pool.ts"
import { createProofService } from "../../src/client/prover.ts"
import { poolClientOptions } from "../../src/client/spend.ts"
import { checkout } from "../../src/env/checkout.ts"
import { anvilKey, USER_INDEX } from "../../src/env/harness/anvil.ts"

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const configAt = (rpcUrl: string) => ({
	rpcUrl,
	chainId: foundry.id,
	deployment: { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n },
	aspUrl: rpcUrl,
	circuitsDir: "unused",
})

test("a circuit bundle survives the config snapshot into the spend and the deposit paths", async () => {
	const rpcUrl = "http://127.0.0.1:9"
	const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(USER_INDEX)) })
	const config = { ...configAt(rpcUrl), circuitBundle: "pre-ceremony" as const }
	const kept = snapshot(config)
	expect(kept.circuitBundle).toBe("pre-ceremony")
	expect(poolClientOptions(kept, addr(5), addr(6), "0x").artifacts).toMatchObject({ bundle: "pre-ceremony" })
	// The deposit prover is built with the user, so a bundle refused on this chain fails the user's creation.
	await expect(createPoolUser(config, { wallet })).rejects.toThrow(
		"CHAIN_MISMATCH: circuit bundle pre-ceremony may not prove for chain 31337",
	)
})

test("a named bundle makes the deposit prover hash its files against that bundle", async () => {
	// Schema-valid, so verification gets as far as reading the verification key.
	const unverifiable = {
		proof: {
			pi_a: ["0x1", "0x2", "0x1"],
			pi_b: [
				["0x1", "0x2"],
				["0x3", "0x4"],
				["0x1", "0x0"],
			],
			pi_c: ["0x1", "0x2", "0x1"],
			protocol: "groth16",
			curve: "bn128",
		},
		publicSignals: ["0x1"],
	} as never
	const circuitsDir = checkout().circuits
	const pre = createProofService({ circuitsDir, chainId: 11_155_111, circuitBundle: "pre-ceremony" })
	// The wasm is shared and passes; whichever of the two keys is read first fails on the pre-ceremony size.
	await expect(pre.verifyDeposit(unverifiable)).rejects.toThrow(/deposit (provingKey|verificationKey): \d+ bytes, pinned (1031707|3744)/)
	// The checkout's files match the ceremony pins, so verification reaches the proof and rejects it.
	expect(await createProofService({ circuitsDir, chainId: foundry.id }).verifyDeposit(unverifiable)).toBe(false)
	expect(await createProofService({ circuitsDir, chainId: foundry.id, circuitBundle: "ceremony" }).verifyDeposit(unverifiable)).toBe(
		false,
	)
	// With no bundle named, a tampered key is still refused: the default is the ceremony bundle, not unchecked files.
	const tampered = join(homedir(), ".cache/pp/pp-env", `tampered-${process.pid}`)
	cpSync(join(circuitsDir, "deposit"), join(tampered, "deposit"), { recursive: true })
	try {
		const vkey = join(tampered, "deposit/groth16_vkey.json")
		writeFileSync(vkey, readFileSync(vkey, "utf8").replace("bn128", "bn129"))
		await expect(createProofService({ circuitsDir: tampered, chainId: foundry.id }).verifyDeposit(unverifiable)).rejects.toThrow(
			"deposit verificationKey: sha256 differs from the manifest",
		)
	} finally {
		rmSync(tampered, { recursive: true, force: true })
	}
	// An empty name from untyped data fails closed instead of reading as the default.
	expect(() => createProofService({ circuitsDir, chainId: foundry.id, circuitBundle: "" as never })).toThrow('unknown circuit bundle ""')
	expect(snapshot({ ...configAt("http://127.0.0.1:9"), circuitBundle: "" as never }).circuitBundle).toBe("" as never)
}, 60_000)

test("a supplied signature is read once, so the one verified is the one keys derive from", async () => {
	const account = privateKeyToAccount(anvilKey(USER_INDEX))
	const wallet = createWalletClient({ chain: foundry, transport: http("http://127.0.0.1:9"), account })
	const valid = await account.signTypedData(secretDerivationTypedData(account.address))
	let reads = 0
	const options = {
		wallet,
		get signature() {
			reads++
			return valid
		},
	}
	const deployment = { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n }
	await createPoolUser(
		{ rpcUrl: "http://127.0.0.1:9", chainId: foundry.id, deployment, aspUrl: "http://127.0.0.1:9", circuitsDir: "unused" },
		options,
	)
	expect(reads).toBe(1)
})

test("a spend with no note to take rejects rather than throwing at the call", async () => {
	// Never contacted: no note is known, so nothing reaches the chain.
	const rpcUrl = "http://127.0.0.1:9"
	const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(USER_INDEX)) })
	const deployment = { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n }
	const user = await createPoolUser({ rpcUrl, chainId: foundry.id, deployment, aspUrl: rpcUrl, circuitsDir: "unused" }, { wallet })
	const spend = user.prepareSpend({ processor: addr(5), data: "0x", asset: addr(6), amountOut: 1n })
	await expect(spend).rejects.toThrow(`no active ${addr(6)} note`)
})

test("note discovery starts at the deployment's block, never at genesis", async () => {
	const deployBlock = 5_000_000n
	const reads: { address?: string; fromBlock?: string }[] = []
	// A chain whose history below the deploy block is pruned, as public Sepolia nodes serve it; GETs are the ASP's.
	const answer = (method: string, params: unknown[]) => {
		if (method === "eth_chainId") return toHex(foundry.id)
		if (method === "eth_blockNumber") return toHex(deployBlock + 100n)
		if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`)
		const [filter] = params as [{ address?: string; fromBlock?: string }]
		reads.push(filter)
		if (BigInt(filter.fromBlock ?? 0) < deployBlock) throw new Error("pruned history unavailable")
		return []
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return new Response("not found", { status: 404 })
			const { id, method, params } = (await req.json()) as { id: number; method: string; params?: unknown[] }
			try {
				return Response.json({ jsonrpc: "2.0", id, result: answer(method, params ?? []) })
			} catch (e) {
				return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message: (e as Error).message } })
			}
		},
	})
	try {
		const rpcUrl = `http://127.0.0.1:${server.port}`
		const base = configAt(rpcUrl)
		const config = { ...base, deployment: { ...base.deployment, deployBlock }, circuitsDir: checkout().circuits }
		const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(USER_INDEX)) })
		await (await createPoolUser(config, { wallet })).sync()
		const vault = reads.filter((r) => r.address?.toLowerCase() === addr(1).toLowerCase())
		expect(vault[0]?.fromBlock).toBe(toHex(deployBlock))
	} finally {
		await server.stop(true)
	}
})
