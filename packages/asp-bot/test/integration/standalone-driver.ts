// A process that runs `runStandaloneBot` as the testnet CLI will: config and the poster's secret as
// values (here a stack-bound sandbox secret in PP_STANDALONE_TEST), stdin unread, SIGTERM to stop.
import { Fr } from "@aztec-labs/aztec.js/fields"
import { runStandaloneBot, type StandaloneBotConfig } from "../../src/standalone"

const { config, poster } = JSON.parse(process.env.PP_STANDALONE_TEST ?? "") as { config: StandaloneBotConfig; poster: string }
const abort = new AbortController()
process.on("SIGTERM", () => abort.abort())
await runStandaloneBot(
	config,
	{ poster: Fr.fromHexString(poster) },
	{
		signal: abort.signal,
		onReady: (r) =>
			process.stdout.write(
				`${JSON.stringify({ event: "ready", url: r.url, post: { ...r.post, sequence: r.post.sequence.toString() } })}\n`,
			),
	},
)
process.stdout.write(`${JSON.stringify({ event: "stopped" })}\n`)
