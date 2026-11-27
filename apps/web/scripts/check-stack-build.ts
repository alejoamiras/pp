/**
 * Three builds into disposable directories under `~/.cache/pp/`: a stack build of a synthetic local
 * manifest (`PP_STACK_MANIFEST`: adapters behind `#data`, the real connector), a stack build of a
 * synthetic remote one, and the plain fixture build. It passes only when every build succeeds, the
 * fixture guard reports it ran in both stack builds (a guard that silently stopped running fails here
 * too), no output file carries a manifest field the target leaves out (the bot's accounts hold a
 * sentinel each), and the demo sender is in the local stack build alone: its sentinel and address
 * there, neither anywhere else, and the dev account's key and the anvil mnemonic in no build at all.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ANVIL_MNEMONIC, anvilKey } from "@pp/bridge-core/sandbox"
import { DEMO_SENDER_ADDRESS, DEMO_SENDER_INDEX } from "@pp/local-stack/accounts"
import { GUARD_PASSED } from "../src/build/plugins.ts"
import { DEMO_SENDER_SENTINEL } from "../src/data/adapters/demo-sender.ts"
import { bunRun, envWithout, scratchDir } from "./proc"

const A20 = (n: string) => `0x${n.repeat(20)}`
const A32 = (n: string) => `0x${n.repeat(32)}`

/** Fields the target never copies; each value appears nowhere else in the manifest. */
const SENTINELS = { poster: A32("5e"), birthIntake: A32("5f") }

/** Loopback only, as the schema requires on 31337; nothing here names a live network. */
const LOCAL_MANIFEST = {
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

/** A stack that is not the local one: the build must bundle the demo sender's stub. */
const REMOTE_MANIFEST = {
	...LOCAL_MANIFEST,
	chainId: 11155111,
	l1Rpc: "https://rpc.invalid",
	aztecNode: "https://node.invalid",
	pool: { ...LOCAL_MANIFEST.pool, aspApiUrl: "https://asp.invalid" },
	bot: { ...LOCAL_MANIFEST.bot, url: "https://bot.invalid" },
}

type Kind = "local" | "remote" | "fixture"
type Output = { file: string; text: string }

/** Every emitted file, lazy chunks and workers included, as lower-cased text. */
function outputOf(dist: string): Output[] {
	return readdirSync(dist, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => ({ file: join(e.parentPath, e.name), text: readFileSync(join(e.parentPath, e.name), "latin1").toLowerCase() }))
}

const holding = (files: Output[], needle: string) => files.filter((f) => f.text.includes(needle.toLowerCase())).map((f) => f.file)

function checkStackOutput(dist: string, files: Output[], manifest: typeof LOCAL_MANIFEST): void {
	for (const [field, value] of Object.entries(SENTINELS)) {
		const found = holding(files, value.slice(2))
		if (found.length > 0) throw new Error(`bot.${field} leaked into ${found.join(", ")}`)
	}
	const csp = (JSON.parse(readFileSync(join(dist, "security-headers.json"), "utf8")) as Record<string, string>)["Content-Security-Policy"]
	for (const origin of [manifest.bot.url, manifest.pool.aspApiUrl])
		if (!csp?.includes(new URL(origin).origin)) throw new Error(`connect-src does not name ${origin}: ${csp}`)
}

/**
 * The demo sender's positive control and its absences: the local stack build carries its sentinel and
 * its address, every other build neither, and no build the dev account's key or the anvil mnemonic.
 */
function checkDemoSender(kind: Kind, files: Output[]): void {
	const key = anvilKey(DEMO_SENDER_INDEX)
	for (const secret of [key, key.slice(2), ANVIL_MNEMONIC]) {
		const found = holding(files, secret)
		if (found.length > 0) throw new Error(`the ${kind} build carries the demo sender's key or the anvil mnemonic: ${found.join(", ")}`)
	}
	const markers = { sentinel: DEMO_SENDER_SENTINEL, address: DEMO_SENDER_ADDRESS.slice(2) }
	for (const [what, needle] of Object.entries(markers)) {
		const found = holding(files, needle)
		if (kind === "local" && found.length === 0) throw new Error(`the local stack build lost the demo sender's ${what}`)
		if (kind !== "local" && found.length > 0)
			throw new Error(`the ${kind} build carries the demo sender's ${what}: ${found.join(", ")}`)
	}
}

async function build(kind: Kind, work: string): Promise<string | null> {
	const dist = join(work, kind, "dist")
	const manifest = kind === "local" ? LOCAL_MANIFEST : REMOTE_MANIFEST
	let env = envWithout()
	if (kind !== "fixture") {
		const file = join(work, `${kind}.json`)
		writeFileSync(file, JSON.stringify(manifest))
		env = { ...env, PP_DATA: "stack", PP_STACK_MANIFEST: file, PP_WEB_WALLETS: "http://127.0.0.1:18081/?profile=plain" }
	}
	const run = bunRun(kind === "fixture" ? ["build", "--", "--outDir", dist] : ["build:local", "--", "--outDir", dist], {
		env,
		capture: true,
	})
	const code = await run.exited
	await run.stop()
	const out = run.output()
	if (code !== 0) throw new Error(`the ${kind} build failed (exit ${code}):\n${out}`)
	const files = outputOf(dist)
	checkDemoSender(kind, files)
	if (kind === "fixture") return null
	const line = out.split("\n").find((l) => l.includes(GUARD_PASSED))
	if (!line) throw new Error(`the ${kind} stack build passed but the fixture guard never reported:\n${out}`)
	checkStackOutput(dist, files, manifest)
	return `${kind}: ${line.trim()}`
}

async function main(): Promise<void> {
	const work = scratchDir("stack-build")
	try {
		const lines = await Promise.all((["local", "remote", "fixture"] as const).map((k) => build(k, work)))
		for (const line of lines) if (line) console.log(line)
		console.log("stack-build sentinels: no bot account in the output; connect-src names the ASP API and the bot")
		console.log("demo sender: sentinel and address in the local stack build only; no build holds its key or the anvil mnemonic")
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

await main()
