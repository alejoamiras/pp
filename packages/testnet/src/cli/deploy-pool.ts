// deploy-pool <deployment file> [--rehearse-fork <url>]
// Deploys the own pool on Sepolia: the pinned pool with the postman role granted to the file's ASP
// postman, the six-decimal test token minted to the canary owner and enabled, every contract's runtime
// code checked against the build. Writes the candidate `pool` section to the run directory.
import { deployPoolOn } from "@pp/pp-env/sepolia"
import { l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { loopback, SEPOLIA } from "../network"
import { POOL_FIELDS } from "../schema"
import { assertOwnTarget } from "./context"
import { cliArgs, guarded, main, report, runDir, writeCandidate } from "./common"

/** Canary runs one test-token mint covers; the token's mint is open, so more can be minted later. */
const MINTED_RUNS = 5n

await main(async () => {
	const { file, mode } = cliArgs(process.argv.slice(2), {})
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack brings its own pool; deploy-pool runs live or on a Sepolia fork")
	const { d } = await guarded(file, mode, ["expected"], false)
	assertOwnTarget(d)
	if (d.pool) throw new GuardError("file", "the file already has a pool section; a second deploy would orphan it")
	const keys = readKeys(RUN_KEYS["deploy-pool"], mode, process.env, l1AddressOf)
	const deployerKey = keys.POOL_DEPLOYER_KEY as `0x${string}`
	const dir = runDir(d, "deploy-pool", mode)
	const pool = await deployPoolOn({
		rpcUrl: d.network.l1Rpc,
		chainId: SEPOLIA,
		deployerKey,
		...(d.expected.aspPostman !== undefined && { postman: d.expected.aspPostman }),
		mint: { to: d.expected.canaryOwner, amount: d.expected.amounts.debit * MINTED_RUNS },
		runDir: dir,
		log: (line) => process.stderr.write(`${line}\n`),
	})
	const p = pool.deployment
	const candidate = writeCandidate(
		dir,
		"pool",
		{
			poolVault: p.pool,
			entrypoint: p.entrypoint,
			aspRegistry: p.aspRegistry,
			keystore: p.keystore,
			asset: pool.asset,
			deployBlock: p.deployBlock,
			aspApiUrl: loopback(d.network.aspPort as number),
			accessRouter: p.accessRouter,
			relay: p.relay,
		},
		POOL_FIELDS,
	)
	report("pool-deployed", {
		deployer: l1AddressOf(deployerKey),
		entrypoint: p.entrypoint,
		asset: pool.asset,
		spentWei: pool.spentWei,
		candidate,
	})
	return 0
})
