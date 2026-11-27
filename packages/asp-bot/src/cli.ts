// `bun src/cli.ts run`: the bot's child process. Its config arrives in PP_BOT_CONFIG; it speaks the
// protocol in `protocol.ts` and stops when its stdin closes or on SIGTERM.
import { createInterface } from "node:readline"
import { PortClaimConflict, registerHostPorts } from "@pp/bridge-core/sandbox"
import type { BotConfig } from "./handle"
import { livePorts } from "./live"
import { Poster } from "./loop"
import { line, parseLine } from "./protocol"
import { Runner } from "./runner"
import { SnapshotBook, serve } from "./server"

const emit = (e: object) => process.stdout.write(line(e))

/** Binds first, then claims the bound port in the host registry; a port another run claimed meanwhile is re-picked. */
async function claimServer(runId: string, book: SnapshotBook) {
	for (let attempt = 0; ; attempt++) {
		const s = await serve(book)
		try {
			await registerHostPorts(runId, "asp-bot", { http: s.port }, process.pid)
			return s
		} catch (e) {
			await s.close()
			if (!(e instanceof PortClaimConflict) || attempt === 4) throw e
		}
	}
}

async function run(c: BotConfig): Promise<void> {
	const book = new SnapshotBook()
	const server = await claimServer(c.runId, book)
	const live = await livePorts(c, (event, fields) => emit({ event, ...fields }))
	const poster = new Poster(live.ports, book, { self: live.self, inclusionMarginSec: BigInt(c.inclusionMarginSec) })
	const runner = new Runner({
		tick: (postNow) => poster.tick(postNow),
		blockNumber: live.blockNumber,
		readiness: () =>
			book.body("latest") === undefined
				? null
				: { url: server.url, port: server.port, poster: live.poster, birthIntake: live.birthIntake },
		emit,
		now: Date.now,
	})
	let stopping = false
	const stop = () => {
		stopping = true
	}
	process.on("SIGTERM", stop)
	process.on("SIGINT", stop)
	createInterface({ input: process.stdin })
		.on("line", (text) => {
			const cmd = parseLine(text)
			if (cmd?.cmd === "post-now" && typeof cmd.id === "number") runner.postNow(cmd.id)
		})
		.on("close", stop)
	while (!stopping) {
		await runner.step()
		await new Promise((r) => setTimeout(r, 1000))
	}
	await server.close()
}

if (process.argv[2] !== "run") {
	process.stderr.write("usage: cli.ts run   (config in PP_BOT_CONFIG)\n")
	process.exit(2)
}
try {
	await run(JSON.parse(process.env.PP_BOT_CONFIG ?? "") as BotConfig)
	process.exit(0)
} catch (e) {
	emit({ event: "fatal", error: e instanceof Error ? e.message : String(e) })
	process.exit(1)
}
