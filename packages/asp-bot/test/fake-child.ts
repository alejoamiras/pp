// Stands in for `cli.ts run` in the handle's tests. Modes: "ok" answers like the bot; "stubborn" does too but
// ignores SIGTERM and leaves a SIGTERM-proof grandchild in its group; "die" exits before ready.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { line } from "../src/protocol"

const mode = process.argv[2]
if (mode === "die") process.exit(3)
if (mode === "stubborn") {
	process.on("SIGTERM", () => {})
	spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" })
}
const config = JSON.parse(process.env.PP_BOT_CONFIG ?? "{}")
process.stdout.write("a stray dependency print\n")
process.stdout.write(line({ event: "ready", url: "http://127.0.0.1:1", port: 1, poster: "0x0b", birthIntake: "0x0c", runId: config.runId }))
createInterface({ input: process.stdin }).on("line", (text) => {
	const { id } = JSON.parse(text)
	const reply =
		id % 2 === 1
			? {
					ok: true,
					record: {
						sequence: "5",
						poolRoot: "11",
						birthRoot: "0",
						l1Block: "30",
						rootTime: "1150",
						poolSize: "2",
						birthSize: "0",
					},
				}
			: { ok: false, reason: "no_newer_block" }
	process.stdout.write(line({ event: "post-now", id, ...reply }))
})
setInterval(() => {}, 1000)
