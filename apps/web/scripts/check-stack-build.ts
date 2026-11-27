/**
 * A stack build (`PP_STACK_MANIFEST`: adapters behind `#data`, the real connector) of a synthetic
 * manifest, into a disposable directory under `~/.cache/pp/`. It passes only when the build succeeds,
 * the fixture guard reports it ran (a guard that silently stopped running fails here too), and no
 * output file carries a manifest field the target leaves out: the bot's accounts hold a sentinel each.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GUARD_PASSED } from "../src/build/plugins.ts"
import { bunRun, envWithout, scratchDir } from "./proc"

const A20 = (n: string) => `0x${n.repeat(20)}`
const A32 = (n: string) => `0x${n.repeat(32)}`

/** Fields the target never copies; each value appears nowhere else in the manifest. */
const SENTINELS = { poster: A32("5e"), birthIntake: A32("5f") }

/** Loopback only, as the schema requires on 31337; nothing here names a live network. */
const SYNTHETIC_MANIFEST = {
	version: 1,
	chainId: 31337,
	l1Rpc: "http://127.0.0.1:18545",
	aztecNode: "http://127.0.0.1:18080",
	pool: {
		poolVault: A20("01"),
		entrypoint: A20("02"),
		aspRegistry: A20("03"),
		keystore: A20("04"),
		asset: A20("05"),
		deployBlock: "7",
		aspApiUrl: "http://127.0.0.1:18600",
	},
	bridge: { factory: A20("06"), portal: A20("07"), hub: A32("08"), token: A32("09"), registry: A32("0a"), deployBlock: "9" },
	bot: { url: "http://127.0.0.1:18700", ...SENTINELS },
}

function scanOutput(dist: string): void {
	const files = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
	for (const e of files) {
		const text = readFileSync(join(e.parentPath, e.name), "latin1")
		for (const [field, value] of Object.entries(SENTINELS))
			if (text.includes(value) || text.includes(value.slice(2)))
				throw new Error(`bot.${field} leaked into ${join(e.parentPath, e.name)}`)
	}
	const csp = (JSON.parse(readFileSync(join(dist, "security-headers.json"), "utf8")) as Record<string, string>)["Content-Security-Policy"]
	for (const origin of [SYNTHETIC_MANIFEST.bot.url, SYNTHETIC_MANIFEST.pool.aspApiUrl])
		if (!csp?.includes(origin)) throw new Error(`connect-src does not name ${origin}: ${csp}`)
}

async function main(): Promise<void> {
	const work = scratchDir("stack-build")
	try {
		const manifest = join(work, "manifest.json")
		writeFileSync(manifest, JSON.stringify(SYNTHETIC_MANIFEST))
		const env = {
			...envWithout(),
			PP_DATA: "stack",
			PP_STACK_MANIFEST: manifest,
			PP_WEB_WALLETS: "http://127.0.0.1:18081/?profile=plain",
		}
		const dist = join(work, "dist")
		const build = bunRun(["build:local", "--", "--outDir", dist], { env, capture: true })
		const code = await build.exited
		await build.stop()
		const out = build.output()
		if (code !== 0) throw new Error(`the stack build failed (exit ${code}):\n${out}`)
		const line = out.split("\n").find((l) => l.includes(GUARD_PASSED))
		if (!line) throw new Error(`the stack build passed but the fixture guard never reported:\n${out}`)
		scanOutput(dist)
		console.log(line.trim())
		console.log("stack-build sentinels: no bot account in the output; connect-src names the ASP API and the bot")
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

await main()
