// bun packages/asp-bot/scripts/with-stack.ts [<demo args> --] <command…>
// Boots `bun run demo --keep` as a child, runs the command with PP_STACK_MANIFEST set, then stops the
// stack with SIGINT (the demo tears down what it started) and exits with the command's code.
// Bun drops a `--` that directly follows the script path, so a bare command needs no separator.
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
const demo = spawn("bun", ["run", "demo", "--keep", ...demoArgs], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
})
const demoExit = new Promise<number | null>((ok) => demo.once("exit", (code) => ok(code)))

const manifest = await new Promise<string>((ok, fail) => {
	for (const stream of [demo.stdout, demo.stderr]) {
		createInterface({ input: stream }).on("line", (text) => {
			process.stderr.write(`[demo] ${text}\n`)
			const found = text.match(/PP_STACK_MANIFEST=(\S+)/)?.[1]
			if (found) ok(found)
		})
	}
	void demoExit.then((code) => fail(new Error(`demo exited (${code}) before writing a manifest`)))
})

const code = await new Promise<number>((ok) => {
	const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, PP_STACK_MANIFEST: manifest } })
	child.once("exit", (c, signal) => ok(c ?? (signal ? 1 : 0)))
})

demo.kill("SIGINT")
const stopped = await Promise.race([demoExit, new Promise<"timeout">((ok) => setTimeout(() => ok("timeout"), 180_000))])
if (stopped !== 130) {
	process.stderr.write(`[with-stack] demo did not stop cleanly (${stopped}); killing its group\n`)
	try {
		process.kill(-(demo.pid as number), "SIGKILL")
	} catch {}
	process.exit(code || 1)
}
process.exit(code)
