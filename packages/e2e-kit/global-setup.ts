/** Proves the run is coherent before a browser opens: the handle names the sandbox the builds were made for. */
import { readHandle } from "@pp/bridge-core/sandbox"
import { runEnv } from "./env"

export default function globalSetup(): void {
	const handle = readHandle(runEnv().artifactsDir)
	if (handle.l1ChainId !== 31337) throw new Error(`the sandbox handle names L1 chain ${handle.l1ChainId}, expected 31337`)
}
