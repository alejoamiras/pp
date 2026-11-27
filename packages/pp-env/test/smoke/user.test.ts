import { expect, test } from "bun:test"
import { createWalletClient, getAddress, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { createPoolUser } from "../../src/client/pool.ts"
import { anvilKey, USER_INDEX } from "../../src/env/harness/anvil.ts"

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)

test("a spend with no note to take rejects rather than throwing at the call", async () => {
	// Never contacted: no note is known, so nothing reaches the chain.
	const rpcUrl = "http://127.0.0.1:9"
	const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(USER_INDEX)) })
	const deployment = { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n }
	const user = await createPoolUser({ rpcUrl, chainId: foundry.id, deployment, aspUrl: rpcUrl, circuitsDir: "unused" }, { wallet })
	const spend = user.prepareSpend({ processor: addr(5), data: "0x", asset: addr(6), amountOut: 1n })
	await expect(spend).rejects.toThrow(`no active ${addr(6)} note`)
})
