// deploy <deployment file>
// Deploys the bridge generation onto the file's pool with entries paused: the L1 factory from the
// committed build, the hub, the labelled token and the ASP registry, proving on and the node's gas.
// Writes the candidate `bridge` section, with the factory's creation transaction, to its run dir.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { deployBridgeGeneration, readDeployJournal } from "@pp/bridge-core/deploy"
import { SANDBOX_ACTOR_SALT } from "@pp/bridge-core/sandbox"
import { sendRetrying } from "@pp/pp-env/send-retry"
import { isAddressEqual } from "viem"
import { l1AddressOf, l2AddressOf } from "../accounts"
import { deployBuildMismatch } from "../creation"
import { GuardError, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { BRIDGE_FIELDS } from "../schema"
import { cliArgs, guarded, main, report, runDir, writeCandidate } from "./common"
import { assertOwnTarget } from "./context"

/** The L2 deploy and send waits on a public network, where proving and checkpoints take minutes. */
const L2_WAIT_SEC = 600

await main(async () => {
	const { file, mode } = cliArgs(process.argv.slice(2), {})
	const { d } = await guarded(file, mode, ["expected", "pool"], true)
	assertOwnTarget(d)
	if (d.bridge) throw new GuardError("bridge", "the file already has a bridge; a new generation is a new file")
	const mismatch = deployBuildMismatch(mode, process.env)
	if (mismatch) throw new GuardError("build", `the forge build is not the committed one: ${mismatch}`)
	const { L1_DEPLOYER_KEY, L2_DEPLOYER_SECRET } = readKeys(RUN_KEYS.deploy, mode, { env: process.env }, l1AddressOf)
	const deployerKey = L1_DEPLOYER_KEY as `0x${string}`
	const l2Secret = L2_DEPLOYER_SECRET as `0x${string}`
	if (!isAddressEqual(l1AddressOf(deployerKey), d.expected.l1Deployer))
		throw new GuardError("account", `the L1 deployer key is not for the file's ${d.expected.l1Deployer}`)
	if (BigInt(await l2AddressOf(l2Secret)) !== BigInt(d.expected.l2Deployer))
		throw new GuardError("account", `the L2 deployer secret derives another account than the file's ${d.expected.l2Deployer}`)
	const dataDir = join(runDir(d, "deploy", mode), "data")
	const journalPath = join(dataDir, "journal.jsonl")
	if (existsSync(journalPath)) throw new GuardError("journal", `${journalPath} exists: a resumed deploy is the owner's call`)
	const u = await deployBridgeGeneration({
		l1Rpc: d.network.l1Rpc,
		wrapL1WalletTransport: (t) => sendRetrying(t),
		aztecNode: d.network.aztecNode,
		chainId: d.network.l1ChainId,
		pool: { poolVault: d.pool.poolVault, asset: d.pool.asset },
		deployerKey,
		guardian: d.expected.guardian,
		lifetimeCap: d.expected.lifetimeCap,
		registry: { poster: d.expected.botPoster, birthIntake: d.expected.birthIntake },
		dataDir,
		l2Deployer: { secret: l2Secret, salt: SANDBOX_ACTOR_SALT },
		proverEnabled: true,
		gasSettings: "node",
		l2WaitTimeoutSec: L2_WAIT_SEC,
	})
	try {
		const step = readDeployJournal(journalPath).find((s) => s.kind === "factory-deployed")
		const factoryTx = step && "txHash" in step ? step.txHash : undefined
		if (!factoryTx) throw new Error(`${journalPath} has no factory creation transaction`)
		const path = writeCandidate(runDir(d, "deploy", mode), "bridge", { ...u.block, factoryTx }, BRIDGE_FIELDS)
		report("deployed", { factory: u.block.factory, portal: u.block.portal, hub: u.block.hub, factoryTx, candidate: path })
		return 0
	} finally {
		await u.stop()
	}
})
