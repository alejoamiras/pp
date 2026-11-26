/** Before a browser opens: the run's handle must name the sandbox chain, 31337. */
import { readHandle } from "@pp/bridge-core/sandbox"
import { runEnv } from "./env"

export default function globalSetup(): void {
	const handle = readHandle(runEnv().artifactsDir)
	if (handle.l1ChainId !== 31337) throw new Error(`the sandbox handle names L1 chain ${handle.l1ChainId}, expected 31337`)
}
