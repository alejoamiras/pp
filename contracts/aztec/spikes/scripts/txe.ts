// Runs the Noir TXE tests against a TXE server this run owns: its own registry-claimed port, process group and
// data directory. `aztec test` is not used because it binds port 8081 for every caller on the machine.
// Usage: bun scripts/txe.ts [nargo test filter args…]
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { claimPorts, releasePorts, releasePortsSync } from "../harness/ports"
import { killGroup, killGroupSync, newRunId, removeRunDir, runDir, spawnGroup, TOOLCHAIN, waitTcp } from "../harness/proc"

const runId = newRunId("txe")
const dir = runDir(runId)
let txe: ReturnType<typeof spawnGroup> | undefined
let nargo: ChildProcess | undefined

// nargo first: blocked on an oracle call, it would outlive a stopped TXE.
async function cleanup(): Promise<void> {
	await killGroup(nargo)
	nargo = undefined
	await killGroup(txe)
	txe = undefined
	await releasePorts(runId)
	removeRunDir(runId)
}
process.once("exit", () => {
	killGroupSync(nargo)
	killGroupSync(txe)
	releasePortsSync(runId)
	removeRunDir(runId)
})
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.once(sig, () => void cleanup().finally(() => process.exit(130)))
}

function expectedTests(): string[] {
	return readFileSync(join(import.meta.dirname, "..", "txe-manifest.txt"), "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"))
}

async function main(): Promise<number> {
	const { txe: port } = await claimPorts(runId, ["txe"] as const)
	console.log(`RUN_ID=${runId} TXE_PORT=${port}`)
	const env = { ...process.env, TXE_PORT: String(port), TMPDIR: join(dir, "tmp"), LOG_LEVEL: "warn" }
	// lmdb's native binding crashes under Bun, so the TXE runs under node.
	txe = spawnGroup("node", [join(TOOLCHAIN, "bin", "aztec-txe")], env, join(dir, "txe.log"))
	await waitTcp(port, 60_000, txe)

	const filter = process.argv.slice(2)
	// The TXE store allows two concurrent readers; more test threads abort the server mid-run.
	const args = ["test", "--silence-warnings", "--oracle-resolver", `http://127.0.0.1:${port}`, "--test-threads", "2", ...filter]
	const out: string[] = []
	const code = await new Promise<number>((res) => {
		const child = spawn(join(TOOLCHAIN, "bin", "aztec-nargo"), args, {
			env: { ...process.env, NARGO_FOREIGN_CALL_TIMEOUT: "1200000" },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		nargo = child
		const tee = (chunk: Buffer, sink: NodeJS.WriteStream) => {
			out.push(chunk.toString())
			sink.write(chunk)
		}
		child.stdout.on("data", (c: Buffer) => tee(c, process.stdout))
		child.stderr.on("data", (c: Buffer) => tee(c, process.stderr))
		child.on("close", (c) => res(c ?? 1))
	})
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes from nargo's output.
	const text = out.join("").replace(/\x1b\[[0-9;]*m/g, "")
	const passed = [...text.matchAll(/(\d+) tests? passed/g)].reduce((n, m) => n + Number(m[1]), 0)
	if (code !== 0) return code
	// nargo exits 0 when a filter matches nothing, so a zero count is a failure.
	if (passed === 0) {
		console.error("no test ran")
		return 1
	}
	if (filter.length === 0) {
		const missing = expectedTests().filter((name) => !new RegExp(`${name}\\s*\\.*\\s*ok`).test(text))
		if (missing.length > 0) {
			console.error(`manifest tests not reported ok:\n  ${missing.join("\n  ")}`)
			return 1
		}
	}
	console.log(`TXE: ${passed} passed (${runId})`)
	return 0
}

const code = await main().catch((e) => {
	console.error(e)
	return 1
})
await cleanup()
process.exit(code)
