import { expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveAnvil } from "./anvil.ts"

const CLI = join(import.meta.dir, "cli.ts")

function cli(args: string[], endpoint?: string) {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
	if (endpoint !== undefined) env.SEPOLIA_RPC_URL = endpoint
	const p = Bun.spawnSync(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" })
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

test("with no endpoint the suite skips in one line, unless --require-rpc makes that a failure", () => {
	for (const endpoint of [undefined, ""]) {
		const skipped = cli(["run"], endpoint)
		expect(skipped.code).toBe(0)
		expect(skipped.out.trim().split("\n")).toEqual([
			"sepolia-fork: skipped: SEPOLIA_RPC_URL is unset (a public Sepolia endpoint with archive state)",
		])
		expect(cli(["run", "--require-rpc"], endpoint).code).toBe(1)
	}
})

test("a command line that is not one fails with usage before any endpoint is read, so it never skips", () => {
	for (const [args, cause] of [
		[["run", "--target", "v8"], "unknown target; known: pool1, vault-323c"],
		[["run", "--targt", "pool1"], "unknown option"],
		[["run", "--https://rpc.example/k3y"], "unknown option"],
		[["run", "--target"], "an option's value is missing or not allowed"],
		[["run", "https://rpc.example/k3y"], "run takes no arguments"],
		[["pins"], "pins takes one block number"],
		[["pins", "1", "2"], "pins takes one block number"],
		[["pins", "1", "--prepare-only"], "pins takes only --target"],
		[["https://rpc.example/k3y"], "the command is run or pins"],
	] as const) {
		const r = cli([...args])
		expect([args, r.code, r.out]).toEqual([args, 2, ""])
		expect(r.err).toContain(`sepolia-fork: ${cause}`)
		expect(r.err).not.toContain("k3y")
	}
})

test("a refused endpoint fails, named by its host alone, at the selected target's block (pool1 by default)", () => {
	// Port 9 (discard) is closed on loopback, so the first call is refused at once.
	const failed = cli(["run"], "http://127.0.0.1:9/v2/k3y")
	expect(failed.code).toBe(1)
	expect(failed.err).toContain("sepolia-fork: endpoint failure: 127.0.0.1:9 no longer serves block 12224362")
	expect(failed.err).not.toContain("k3y")
	const old = cli(["run", "--target", "vault-323c"], "http://127.0.0.1:9/v2/k3y")
	expect(old.err).toContain("no longer serves block 12220000")
	const unparseable = cli(["run"], "rpc.example/v2/k3y")
	expect([unparseable.code, unparseable.err.trim()]).toEqual([1, "sepolia-fork: SEPOLIA_RPC_URL is not an http(s) URL"])
})

test("only an anvil reporting the pinned Foundry version is used", () => {
	const dir = join(homedir(), ".cache/pp/fork", `resolve-test-${process.pid}`)
	mkdirSync(dir, { recursive: true })
	try {
		const fake = (name: string, version: string) => {
			const bin = join(dir, name)
			writeFileSync(bin, `#!/bin/sh\necho "anvil Version: ${version}"\n`)
			chmodSync(bin, 0o755)
			return bin
		}
		const newer = fake("newer", "1.8.5")
		const pinned = fake("pinned", "1.7.1")
		expect(resolveAnvil([newer, join(dir, "absent"), pinned])).toBe(pinned)
		expect(() => resolveAnvil([newer])).toThrow(`no anvil 1.7.1 found; tried ${newer} (anvil Version: 1.8.5)`)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
