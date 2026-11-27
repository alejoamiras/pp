import { expect, test } from "bun:test"
import { join } from "node:path"
import { waitFor } from "./rpc.ts"

const RPC_TS = JSON.stringify(join(import.meta.dir, "rpc.ts"))

test("a probe still pending at the deadline fails at the deadline", async () => {
	const t0 = performance.now()
	await expect(waitFor("stalled", () => new Promise<boolean>(() => {}), 100)).rejects.toThrow("within 100 ms")
	expect(performance.now() - t0).toBeLessThan(200)
})

test("a readiness wait that succeeds leaves no timer keeping the process alive", async () => {
	const script = `import { waitFor } from ${RPC_TS}
	await waitFor("ready", async () => true, 20_000)`
	const t0 = performance.now()
	await Bun.spawn(["bun", "-e", script], { stderr: "inherit" }).exited
	expect(performance.now() - t0).toBeLessThan(5_000)
})
