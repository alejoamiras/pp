// bot <deployment file>
// Runs the ASP-root poster, its snapshot server and, when shields are open, the birth intake in this
// process on the file's bot port, until SIGINT or SIGTERM. Prints the first post it checkpointed.
import { Fr } from "@aztec-labs/aztec.js/fields"
import { runStandaloneBot } from "@pp/asp-bot/standalone"
import { l1AddressOf, l2AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { cliArgs, guarded, main, report } from "./common"

/** A shield needs a birth intake: a zero intake keeps shields paused, so the bot approves none. */
const shieldsOpen = (birthIntake: string) => BigInt(birthIntake) !== 0n

await main(async () => {
	const { file, mode } = cliArgs(process.argv.slice(2), {})
	const { d } = await guarded(file, mode, ["expected", "pool", "bridge"], true)
	const shields = shieldsOpen(d.expected.birthIntake)
	const specs = shields ? RUN_KEYS["bot-shields"] : RUN_KEYS.bot
	const keys = readKeys(specs, mode, process.env, l1AddressOf)
	const poster = keys.BOT_POSTER_SECRET as `0x${string}`
	const intake = keys.BOT_INTAKE_SECRET as `0x${string}` | undefined
	if (BigInt(await l2AddressOf(poster)) !== BigInt(d.expected.botPoster))
		throw new GuardError("account", `the poster secret derives another account than the file's ${d.expected.botPoster}`)
	if (intake && BigInt(await l2AddressOf(intake)) !== BigInt(d.expected.birthIntake))
		throw new GuardError("account", `the intake secret derives another account than the file's ${d.expected.birthIntake}`)
	const stop = new AbortController()
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort())
	await runStandaloneBot(
		{
			deployment: {
				l1Rpc: d.network.l1Rpc,
				aztecNode: d.network.aztecNode,
				aspApiUrl: d.pool.aspApiUrl,
				aspRegistry: d.pool.aspRegistry,
				entrypoint: d.pool.entrypoint,
				chainId: d.network.l1ChainId,
				registry: d.bridge.registry,
				tokens: shields ? [d.bridge.token] : [],
			},
			runId: `pp-testnet-bot-${d.target}-${process.pid}`,
			port: d.network.botPort,
			inclusionMarginSec: 300,
			postTimeoutSec: 600,
		},
		{ poster: Fr.fromHexString(poster), ...(intake ? { intake: Fr.fromHexString(intake) } : {}) },
		{
			signal: stop.signal,
			onReady: ({ url, post }) => report("bot-ready", { url, sequence: post.sequence, txHash: post.txHash, l2Block: post.l2Block }),
		},
	)
	report("bot-stopped", { target: d.target })
	return 0
})
