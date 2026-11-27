// asp <deployment file> --owner <address> [--rehearse-fork <url>]
// Runs the own pool's mock ASP on the file's loopback port until SIGINT or SIGTERM: it approves only
// the canary owner's deposits, posts each grown set's root with the postman key, and serves reads only.
import { claimRows, releaseNamed } from "@pp/run-isolation/ports"
import { getAddress, isAddress, isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { SEPOLIA } from "../network"
import { assertOwnTarget } from "./context"
import { cliArgs, guarded, logLine, main, report } from "./common"

const SERVICE = "pp-testnet-asp"

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), { owner: { type: "string" } })
	if (mode.kind === "rehearse") throw new GuardError("argv", "the local stack brings its own ASP; asp runs live or on a Sepolia fork")
	const { d } = await guarded(file, mode, ["expected", "pool"], false)
	assertOwnTarget(d)
	const owner = values.owner
	if (typeof owner !== "string" || !isAddress(owner)) throw new GuardError("argv", "--owner <address> is required")
	if (!isAddressEqual(owner, d.expected.canaryOwner))
		throw new GuardError("account", `--owner ${owner} is not the file's canary owner ${d.expected.canaryOwner}`)
	const { accessRouter, aspRegistry, poolVault, entrypoint, deployBlock } = d.pool
	if (!accessRouter) throw new GuardError("file", "the pool section names no access router")
	const keys = readKeys(RUN_KEYS.asp, mode, { env: process.env }, l1AddressOf)
	const postmanKey = keys.ASP_POSTMAN_KEY as `0x${string}`
	const postman = l1AddressOf(postmanKey)
	if (d.expected.aspPostman !== undefined && !isAddressEqual(postman, d.expected.aspPostman))
		throw new GuardError("account", `the postman key is for ${postman}, the file expects ${d.expected.aspPostman}`)
	// Past the guards: this entry loads the pool checkout, which a refusal must not need.
	const { startMockAsp } = await import("@pp/pp-env/sepolia")
	const port = d.network.aspPort as number
	const runId = `pp-testnet-asp-${d.target}-${process.pid}`
	await claimRows(runId, { [SERVICE]: port }, process.pid)
	const stop = new AbortController()
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort())
	try {
		const asp = await startMockAsp({
			rpcUrl: d.network.l1Rpc,
			chainId: SEPOLIA,
			postmanKey,
			deployment: { accessRouter, aspRegistry, pool: poolVault, entrypoint, deployBlock },
			port,
			owners: [getAddress(owner)],
			log: logLine,
		})
		report("asp-ready", { url: asp.url, owner, postman, approved: asp.approved().length })
		if (!stop.signal.aborted) await new Promise((resolve) => stop.signal.addEventListener("abort", resolve, { once: true }))
		await asp.stop()
		report("asp-stopped", { approved: asp.approved().length, scanned: asp.scanned() })
	} finally {
		if (!(await releaseNamed([{ port, service: SERVICE, owner: runId }])))
			logLine(`port row ${port} (${runId}) was not released; remove it from the registry by hand`)
	}
	return 0
})
