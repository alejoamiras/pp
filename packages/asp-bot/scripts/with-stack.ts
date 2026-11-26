// bun packages/asp-bot/scripts/with-stack.ts [<demo args> --] <command…>
// Runs the command against a fresh `bun run demo --keep`, with PP_STACK_MANIFEST set, and exits with its code.
// Bun drops a `--` placed right after the script path, so a bare command needs no separator.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const argv = process.argv.slice(2)
const sep = argv.indexOf("--")
const demoArgs = sep < 0 ? [] : argv.slice(0, sep)
const command = sep < 0 ? argv : argv.slice(sep + 1)
if (command.length === 0) {
	process.stderr.write("usage: with-stack.ts [<demo args> --] <command…>\n")
	process.exit(2)
}
const [cmd, ...args] = command as [string, ...string[]]
// Its own group, so the SIGKILL fallback can reach every member; a terminal's Ctrl+C then reaches it only through `finish`.
const demo = spawn("bun", ["run", "demo", "--keep", ...demoArgs], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
})
const demoExit = new Promise<number | null>((ok) => demo.once("exit", (code) => ok(code)))

/** SIGINT lets the demo tear down what it started; it exits 130 once it has. */
async function finish(code: number): Promise<never> {
	demo.kill("SIGINT")
	const stopped = await Promise.race([demoExit, new Promise<"timeout">((ok) => setTimeout(() => ok("timeout"), 180_000))])
	if (stopped === 130) process.exit(code)
	process.stderr.write(`[with-stack] demo did not stop cleanly (${stopped}); killing its group\n`)
	try {
		process.kill(-(demo.pid as number), "SIGKILL")
	} catch {}
	process.exit(code || 1)
}
let finishing: Promise<never> | undefined
const finishOnce = (code: number) => {
	finishing ??= finish(code)
	return finishing
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void finishOnce(130))

const manifest = await new Promise<string>((ok, fail) => {
	for (const stream of [demo.stdout, demo.stderr]) {
		createInterface({ input: stream }).on("line", (text) => {
			process.stderr.write(`[demo] ${text}\n`)
			const found = text.match(/PP_STACK_MANIFEST=(\S+)/)?.[1]
			if (found) ok(found)
		})
	}
	void demoExit.then((code) => finishing ?? fail(new Error(`demo exited (${code}) before writing a manifest`)))
})

const code = await new Promise<number>((ok) => {
	const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, PP_STACK_MANIFEST: manifest } })
	child.once("exit", (c) => ok(c ?? 1))
})
await finishOnce(code)
