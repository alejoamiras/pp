import { expect, test } from "bun:test"
import { createWalletClient, getAddress, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { secretDerivationTypedData } from "../../src/client/derivation.ts"
import { createPoolUser } from "../../src/client/pool.ts"
import { anvilKey, USER_INDEX } from "../../src/env/harness/anvil.ts"

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)

test("a supplied signature is read once, so the one verified is the one keys derive from", async () => {
	const account = privateKeyToAccount(anvilKey(USER_INDEX))
	const wallet = createWalletClient({ chain: foundry, transport: http("http://127.0.0.1:9"), account })
	const valid = await account.signTypedData(secretDerivationTypedData(account.address))
	let reads = 0
	const options = {
		wallet,
		get signature() {
			reads++
			return valid
		},
	}
	const deployment = { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n }
	await createPoolUser(
		{ rpcUrl: "http://127.0.0.1:9", chainId: foundry.id, deployment, aspUrl: "http://127.0.0.1:9", circuitsDir: "unused" },
		options,
	)
	expect(reads).toBe(1)
})

test("a spend with no note to take rejects rather than throwing at the call", async () => {
	// Never contacted: no note is known, so nothing reaches the chain.
	const rpcUrl = "http://127.0.0.1:9"
	const wallet = createWalletClient({ chain: foundry, transport: http(rpcUrl), account: privateKeyToAccount(anvilKey(USER_INDEX)) })
	const deployment = { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 0n }
	const user = await createPoolUser({ rpcUrl, chainId: foundry.id, deployment, aspUrl: rpcUrl, circuitsDir: "unused" }, { wallet })
	const spend = user.prepareSpend({ processor: addr(5), data: "0x", asset: addr(6), amountOut: 1n })
	await expect(spend).rejects.toThrow(`no active ${addr(6)} note`)
})
