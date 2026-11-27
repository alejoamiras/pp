/**
 * A stack build (`PP_DATA=stack`: adapters behind `#data`, the real connector) of a synthetic target,
 * into a disposable directory under `~/.cache/pp/`. It passes only when the build succeeds and the
 * fixture guard reports it ran: a guard that silently stopped running fails here too.
 */
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GUARD_PASSED } from "../src/build/plugins.ts"
import { bunRun, envWithout, scratchDir } from "./proc"

/** Public fields only; nothing here names a live network. */
const SYNTHETIC_HANDLE = {
	nodeUrl: "http://127.0.0.1:18080",
	anvilUrl: "http://127.0.0.1:18545",
	l1ChainId: 31337,
	rollupVersion: 1,
}

async function main(): Promise<void> {
	const work = scratchDir("stack-build")
	try {
		writeFileSync(join(work, "handle.json"), JSON.stringify(SYNTHETIC_HANDLE))
		const env = {
			...envWithout(),
			PP_DATA: "stack",
			PP_SANDBOX_ARTIFACTS: work,
			PP_WEB_WALLETS: "http://127.0.0.1:18081/?profile=plain",
		}
		const build = bunRun(["build:local", "--", "--outDir", join(work, "dist")], { env, capture: true })
		const code = await build.exited
		await build.stop()
		const out = build.output()
		if (code !== 0) throw new Error(`the stack build failed (exit ${code}):\n${out}`)
		const line = out.split("\n").find((l) => l.includes(GUARD_PASSED))
		if (!line) throw new Error(`the stack build passed but the fixture guard never reported:\n${out}`)
		console.log(line.trim())
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

await main()
