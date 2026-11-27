import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { isRunId } from "../run-id.ts"
import { assertForkNode } from "./fork-node.ts"

const node =
	(version: string, chainHex: string) =>
	async <T>(_url: string, method: string): Promise<T> =>
		(method === "web3_clientVersion" ? version : chainHex) as T
const ownedBy = (runId: string) => (port: number) => (port === 1234 ? runId : undefined)
const OWN = { rpcUrl: "http://127.0.0.1:1234", clientVersion: "anvil/v1.7.1", chainId: 11_155_111, runId: "suite-1" }

test("the fork guard accepts only the caller's own anvil on 127.0.0.1, at the version and chain it names", async () => {
	const ok = node("anvil/v1.7.1", "0xaa36a7")
	await assertForkNode(OWN, ok, ownedBy("suite-1"))
	for (const rpcUrl of ["https://rpc.example", "http://[::1]:1234", "http://localhost:1234"])
		await expect(assertForkNode({ ...OWN, rpcUrl }, ok, ownedBy("suite-1"))).rejects.toThrow("must listen on 127.0.0.1")
	// An untyped caller with no run id, at a port no run registered.
	const unset = { ...OWN, runId: undefined as unknown as string }
	await expect(assertForkNode({ ...unset, rpcUrl: "http://127.0.0.1:4321" }, ok, ownedBy("suite-1"))).rejects.toThrow(
		"registered to no run",
	)
	expect([undefined, null, "undefined", "suite-1"].map(isRunId)).toEqual([false, false, true, true])
	await expect(assertForkNode(OWN, ok, ownedBy("suite-2"))).rejects.toThrow("port 1234: registered to suite-2, not suite-1")
	await expect(assertForkNode({ ...OWN, rpcUrl: "http://127.0.0.1:4321" }, ok, ownedBy("suite-1"))).rejects.toThrow(
		"registered to no run",
	)
	await expect(assertForkNode(OWN, node("anvil/v1.8.5", "0xaa36a7"), ownedBy("suite-1"))).rejects.toThrow("expected exactly anvil/v1.7.1")
	// A caller that names a live node's own version still gets no further than "an anvil".
	await expect(
		assertForkNode({ ...OWN, clientVersion: "Geth/v1.14" }, node("Geth/v1.14", "0xaa36a7"), ownedBy("suite-1")),
	).rejects.toThrow("an anvil")
	await expect(assertForkNode(OWN, node("anvil/v1.7.1", "0x1"), ownedBy("suite-1"))).rejects.toThrow("chain 1: expected 11155111")
})

test("the fork path never reaches the mnemonic keys or the local clients", () => {
	const seen = new Set<string>()
	const walk = (file: string) => {
		if (seen.has(file)) return
		seen.add(file)
		for (const [, rel] of readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)) walk(resolve(dirname(file), rel!))
	}
	walk(join(import.meta.dir, "../fork.ts"))
	const reached = [...seen].map((f) => f.slice(f.indexOf("/src/") + 1))
	expect(reached).not.toContain("src/env/harness/anvil.ts")
	expect(reached).not.toContain("src/env/index.ts")
	for (const f of seen) expect(readFileSync(f, "utf8")).not.toMatch(/\b(anvilKey|localClients|mnemonicToAccount)\b/)
})
