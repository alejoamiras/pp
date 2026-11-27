/** Before a browser opens: the run's network must be on the local chain, 31337. */
import { readFileSync } from "node:fs"
import { parseStackManifest } from "@pp/bridge-core"
import { readHandle } from "@pp/bridge-core/sandbox"
import { runEnv, stackRun } from "./env"

const LOCAL_CHAIN_ID = 31337

export default function globalSetup(): void {
	const run = runEnv()
	const chainId =
		run.mode === "stack"
			? parseStackManifest(JSON.parse(readFileSync(stackRun(run).manifestPath, "utf8"))).chainId
			: readHandle(run.artifactsDir).l1ChainId
	if (chainId !== LOCAL_CHAIN_ID) throw new Error(`the ${run.mode} names L1 chain ${chainId}, expected ${LOCAL_CHAIN_ID}`)
}
