import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { assertForkNode } from "./fork-node.ts"

const node =
	(version: string, chainHex: string) =>
	async <T>(_url: string, method: string): Promise<T> =>
		(method === "web3_clientVersion" ? version : chainHex) as T

test("the fork guard accepts only the loopback anvil version and chain its caller names", async () => {
	const ok = node("anvil/v1.7.1", "0xaa36a7")
	await assertForkNode("http://127.0.0.1:1234", "anvil/v1.7.1", 11_155_111, ok)
	await expect(assertForkNode("https://rpc.example", "anvil/v1.7.1", 11_155_111, ok)).rejects.toThrow("non-loopback")
	await expect(assertForkNode("http://127.0.0.1:1234", "anvil/v1.7.1", 11_155_111, node("anvil/v1.8.5", "0xaa36a7"))).rejects.toThrow(
		"expected exactly anvil/v1.7.1",
	)
	await expect(assertForkNode("http://127.0.0.1:1234", "anvil/v1.7.1", 11_155_111, node("Geth/v1.14", "0xaa36a7"))).rejects.toThrow(
		"refusing to attach to Geth",
	)
	await expect(assertForkNode("http://127.0.0.1:1234", "anvil/v1.7.1", 11_155_111, node("anvil/v1.7.1", "0x1"))).rejects.toThrow(
		"chain 1: expected 11155111",
	)
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
