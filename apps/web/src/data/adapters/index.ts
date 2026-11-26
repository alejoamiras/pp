/** The stack behind `#data`: the real wallet connector, and ports that refuse until their packages land. */
import type { DataSource } from "../source"
import { loadRealConnector } from "../wallet/load"

const unavailable = (port: string) => (): Promise<never> => Promise.reject(new Error(`${port} has no stack adapter in this build`))

export const source: DataSource = {
	mode: "stack",
	clock: { aztecNow: unavailable("ChainClock.aztecNow"), l1Now: unavailable("ChainClock.l1Now") },
	wallet: loadRealConnector,
}
