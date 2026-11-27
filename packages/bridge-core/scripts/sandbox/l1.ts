/** L1 side of the sandbox: the token fixtures the generation and the flows need, and the small write
 *  helpers every flow shares. */
import type { Address, Hex } from "viem"
import type { L1Ctx } from "../l1-ctx"
import { evmArtifact } from "../script-artifacts"
import { lc, type SpecKey, SPECS, type TokenSpec } from "./constants"

export async function deployEvm(l1: L1Ctx, name: string, args: unknown[]): Promise<Address> {
	const { abi, bytecode } = evmArtifact(name)
	const hash = await l1.wallet.deployContract({ abi, bytecode, args, account: l1.account, chain: l1.wallet.chain } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`)
	return lc(receipt.contractAddress)
}

export async function writeL1(l1: L1Ctx, address: Address, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
	const hash = await l1.wallet.writeContract({
		address,
		abi: abi as never,
		functionName,
		args: args as never,
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	await l1.pub.waitForTransactionReceipt({ hash })
	return hash
}

export async function mint(l1: L1Ctx, erc20: Address, to: Address, amount: bigint): Promise<void> {
	await writeL1(l1, erc20, evmArtifact("MintableERC20").abi, "mint", [to, amount])
}

export async function freshToken(l1: L1Ctx, spec: TokenSpec, mintTo: Address[], amount: bigint): Promise<Address> {
	const erc20 = await deployEvm(l1, "MintableERC20", [spec.name, spec.symbol, spec.decimals, 1_000_000n])
	for (const to of mintTo) await mint(l1, erc20, to, amount)
	return erc20
}

export async function erc20BalanceOf(l1: L1Ctx, erc20: Address, owner: Address): Promise<bigint> {
	return (await l1.pub.readContract({
		address: erc20,
		abi: evmArtifact("MintableERC20").abi,
		functionName: "balanceOf",
		args: [owner],
	})) as bigint
}

export interface L1Deployment {
	registry: Address
	tokens: Record<SpecKey, Address>
}

export async function deployL1Fixtures(l1: L1Ctx, addrs: { registry: Address }): Promise<L1Deployment> {
	// Sequential on purpose: these share one L1 account, and viem assigns each tx the nonce it reads
	// at build time — issuing them together makes every tx after the first "nonce too low".
	const entries: (readonly [string, Address])[] = []
	for (const [key, spec] of Object.entries(SPECS)) {
		const address = await deployEvm(l1, "MintableERC20", [spec.name, spec.symbol, spec.decimals, 1_000_000n])
		console.log(`  ${spec.symbol}: ${address}`)
		entries.push([key, address])
	}
	return { ...addrs, tokens: Object.fromEntries(entries) as L1Deployment["tokens"] }
}
