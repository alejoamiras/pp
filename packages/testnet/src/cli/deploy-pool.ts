// deploy-pool <deployment file> [--rehearse-fork <url>]
// Deploys the own pool on Sepolia: the pinned pool with the postman role granted to the file's ASP
// postman, the six-decimal test token minted to the canary owner and enabled, every contract's runtime
// code checked against the build. Writes the candidate `pool` section to the run directory.
import { isAddressEqual } from "viem"
import { l1AddressOf } from "../accounts"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { loopback, SEPOLIA } from "../network"
import { POOL_FIELDS } from "../schema"
import { feeAboveBudget, scriptFees } from "../funding"
import { assertOwnPool } from "./context"
import { cliArgs, guarded, logLine, main, report, runDir, writeCandidate } from "./common"
import { sendRpcOf } from "./wallet"

/** Canary runs one test-token mint covers; the token's mint is open, so more can be minted later. */
const MINTED_RUNS = 5n

/** The pool and test-token artifacts pp-env just built are the ones `pool-creation-codes.json` pins. */
async function checkPoolPins(): Promise<void> {
	const { committedPoolCodes, pinMismatches, poolCreationCodes } = await import("../pins")
	const bad = pinMismatches(poolCreationCodes(), committedPoolCodes())
	if (bad.length) throw new Error(`the pool build is not the pinned one:\n  ${bad.join("\n  ")}`)
	logLine("the pool build matches its pins")
}

await main(async () => {
	const { file, mode } = cliArgs(process.argv.slice(2), {})
	if (mode.kind === "rehearse")
		throw new GuardError("argv", "the local stack brings its own pool; deploy-pool runs live or on a Sepolia fork")
	const { d, l1 } = await guarded(file, mode, ["expected"], false)
	assertOwnPool(d)
	if (d.pool) throw new GuardError("file", "the file already has a pool section; a second deploy would orphan it")
	const keys = readKeys(RUN_KEYS["deploy-pool"], mode, { env: process.env }, l1AddressOf)
	const deployerKey = keys.POOL_DEPLOYER_KEY as `0x${string}`
	const deployer = l1AddressOf(deployerKey)
	if (!d.expected.poolDeployer || !isAddressEqual(deployer, d.expected.poolDeployer))
		throw new GuardError("account", `the pool deployer key is for ${deployer}, the file expects ${d.expected.poolDeployer ?? "none"}`)
	const estimate = (await l1.estimateFeesPerGas()).maxFeePerGas
	const pricey = feeAboveBudget({ maxFeePerGas: estimate, balance: await l1.getBalance({ address: deployer }) })
	if (pricey) throw new GuardError("fees", pricey)
	const fees = scriptFees(estimate)
	const dir = runDir(d, "deploy-pool", mode)
	// Past the guards: this entry loads the pool checkout, which a refusal must not need.
	const { deployPoolOn } = await import("@pp/pp-env/sepolia")
	logLine(`forge's fee caps: max ${fees.maxFeePerGas} wei, tip ${fees.maxPriorityFeePerGas} wei per gas`)
	const pool = await deployPoolOn({
		rpcUrl: d.network.l1Rpc,
		sendRpcUrl: sendRpcOf(d),
		fees,
		chainId: SEPOLIA,
		deployerKey,
		...(d.expected.aspPostman !== undefined && { postman: d.expected.aspPostman }),
		mint: { to: d.expected.canaryOwner, amount: d.expected.amounts.debit * MINTED_RUNS },
		runDir: dir,
		checkBuild: checkPoolPins,
		log: logLine,
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
		deployer,
		entrypoint: p.entrypoint,
		asset: pool.asset,
		spentWei: pool.spentWei,
		candidate,
	})
	return 0
})
