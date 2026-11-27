import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { anvilAccount } from "@pp/pool-client/testing"
import { type Hex, toHex } from "viem"
import { afterAll, describe, expect, it } from "vitest"
import { serializeStackManifest } from "../../../src/stack-manifest"
import { fundedIndex, send } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"
import { scratch } from "./support/stack"

const k = exitKit("cli")
const dir = scratch("cli")
afterAll(() => dir.remove())

const PACKAGE = fileURLToPath(new URL("../../..", import.meta.url))

/** A loopback port nothing listens on once this returns. */
async function closedPort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
	const { port } = server.address() as { port: number }
	await new Promise((r) => server.close(r))
	return port
}

/** `bun run ragequit` in a fresh process whose environment holds only the manifest, `keys` and what bun needs to start. */
async function ragequit(args: string[], manifest: string, keys: Record<string, Hex>) {
	const env = { PATH: process.env.PATH, HOME: process.env.HOME, PP_STACK_MANIFEST: manifest, ...keys }
	const { stdout, stderr } = await promisify(execFile)("bun", ["scripts/ragequit.ts", ...args], { cwd: PACKAGE, env, timeout: 240_000 })
	const out = stdout + stderr
	for (const key of Object.values(keys)) expect(out).not.toContain(key.slice(2))
	return out
}

describe("cli", () => {
	it("E2 bun run ragequit exits from keys alone with the ASP down, and --settle-only settles another ticket from chain data with the L1 key alone", async () => {
		await k.timed("E2", async () => {
			const { client, holder, label } = await k.claimed(100n, [10n, 10n])
			const manifest = join(dir.path, "manifest.json")
			const closed = `http://127.0.0.1:${await closedPort()}`
			writeFileSync(manifest, serializeStackManifest({ ...k.m, pool: { ...k.m.pool, aspApiUrl: closed } }))
			const l1Key = toHex(anvilAccount(await fundedIndex(k.m)).getHdKey().privateKey!)
			const payee = freshPayee()

			// A fresh process with its own wallet, which has made only non-interactive handshakes.
			const first = await ragequit(["--amount", "10", "--payee", payee], manifest, {
				PP_AZTEC_SECRET: holder.secret,
				PP_L1_KEY: l1Key,
			})
			expect(first).toMatch(/settled ragequit of 10/)
			expect(await k.balanceOf(payee)).toBe(10n)

			const burn = await send(k.dev(), holder.address, await client.ragequitPayload({ payee, amount: 10n, label }))
			const ticket = (await client.exitTickets({ payee })).find((t) => t.l2TxHash === burn.txHash.toString())
			expect(await client.exitStatus(ticket!)).not.toBe("settled")

			const second = await ragequit(["--settle-only", "--payee", payee], manifest, { PP_L1_KEY: l1Key })
			expect(second).toMatch(/already settled: ragequit of 10/)
			expect(await client.exitStatus(ticket!)).toBe("settled")
			expect(await k.balanceOf(payee)).toBe(20n)
		})
	})
})
