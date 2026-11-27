import { LOCAL_TIMING, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { expect, test } from "vitest"
import { bridgeTiming } from "./timing"

test.each([
	[31337, "http://127.0.0.1:8545", LOCAL_TIMING],
	[31337, "http://localhost:8545", LOCAL_TIMING],
	[31337, "https://rpc.example.org", PUBLIC_CHAIN_TIMING],
	[11155111, "http://127.0.0.1:8545", PUBLIC_CHAIN_TIMING],
	[31337, "not a url", PUBLIC_CHAIN_TIMING],
])("chain %i over %s waits as %o", (chainId, l1Rpc, timing) => {
	expect(bridgeTiming({ chainId, l1Rpc })).toBe(timing)
})
