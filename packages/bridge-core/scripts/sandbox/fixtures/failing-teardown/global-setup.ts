import { writeFileSync } from "node:fs"
import { teardownNetwork } from "../../local-network"

const net = (stop: () => Promise<void>, left: string[]) => ({ anvilUrl: "", nodeUrl: "", stop, leftovers: () => left })

/** `TEARDOWN_CASE=stop-throws`: the stop rejects, and cleanup touches `TEARDOWN_MARKER`. Otherwise the
 *  stop succeeds and leaves a registry row. */
export default function setup(): () => Promise<void> {
	if (process.env.TEARDOWN_CASE !== "stop-throws") return () => teardownNetwork(net(async () => {}, ["registry row 1"]))
	const failed = async () => {
		throw new Error("registry stayed locked")
	}
	return () => teardownNetwork(net(failed, []), () => writeFileSync(process.env.TEARDOWN_MARKER ?? "", ""))
}
