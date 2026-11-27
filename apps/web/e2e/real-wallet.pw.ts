/**
 * The pinned release of the real wallet, driven through its own windows behind the browser-level
 * fence (run with `bun run --cwd packages/e2e-kit test:real-wallet`). Serial, one account: each
 * test builds on the state the previous one left.
 */
import { expect, test } from "@pp/e2e-kit/real-wallet/fixture.ts"

test.describe.configure({ mode: "serial" })

test("boot", async ({ realWallet: rw }) => {
	await rw.driver.onboard()
	const id = await rw.driver.addNetwork("pp-local", rw.node.url)
	expect(id, "the wallet chain id the stack's network gets").toBe(rw.expectedChainId)
	await expect
		.poll(() => rw.node.calls().some((c) => c.name === "getNodeInfo"), {
			message: "the wallet reaches the stack through the recording proxy",
			timeout: 60_000,
		})
		.toBe(true)
})
