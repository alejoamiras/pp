// Test-only chain actions against `pp-env up`: the package itself never submits.
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CIRCUIT_MANIFEST } from "@0xbow/privacy-pools-v2-sdk"
import {
	type Address,
	BaseError,
	ContractFunctionRevertedError,
	createPublicClient,
	createTestClient,
	createWalletClient,
	erc20Abi,
	type Hex,
	http,
	isAddressEqual,
	parseAbi,
	parseEventLogs,
	toHex,
} from "viem"
import { foundry } from "viem/chains"
import { STUB_PROCESSOR_ABI } from "../../../pp-env/src/env/stub-abi.ts"
import { POOL_VAULT_ERRORS_ABI } from "../../src/abi.ts"
import { deriveKeys } from "../../src/keys.ts"
import { createArtifacts, PINNED_CIRCUITS, type PinnedCircuit } from "../../src/runtime/artifacts.ts"
import { createSession } from "../../src/session.ts"
import type { PreparedSpend } from "../../src/types.ts"
import { poolConfig, type UpEnv } from "./env.ts"
import { circuitsDir, PACKAGE_DIR } from "./paths.ts"
import { anvilAccount, derivationSignature } from "./users.ts"

/** pp-env's deployer, which is also the ASP postman. */
const DEPLOYER_INDEX = 14
const SPEND_ABI = [...STUB_PROCESSOR_ABI, ...POOL_VAULT_ERRORS_ABI]

/** Deposits prove the `deposit` circuit, which the client itself never needs. */
function depositCircuit(): PinnedCircuit {
	const dir = join(circuitsDir(), "deposit")
	const size = (f: string) => statSync(join(dir, f)).size
	return {
		...DEFAULT_CIRCUIT_MANIFEST.deposit!,
		sizes: { wasm: size("deposit_js/deposit.wasm"), provingKey: size("groth16_pkey.zkey"), verificationKey: size("groth16_vkey.json") },
	}
}

export const spendArgs = (s: PreparedSpend) => [s.proof, { processor: s.processor, data: s.data }, s.noteData] as const

export type Simulation = { ok: true } | { ok: false; errorName: string | undefined; raw: Hex | undefined }

export function seeder(env: UpEnv) {
	const chain = { ...foundry, rpcUrls: { default: { http: [env.rpcUrl] } } }
	const transport = http(env.rpcUrl)
	const client = createPublicClient({ chain, transport, pollingInterval: 100 })
	const walletOf = (index: number) => createWalletClient({ chain, transport, account: anvilAccount(index) })
	const deployer = walletOf(DEPLOYER_INDEX)
	const mined = async (hash: Hex) => {
		const r = await client.waitForTransactionReceipt({ hash })
		if (r.status !== "success") throw new Error(`${hash} reverted`)
		return r
	}
	const artifacts = createArtifacts({ kind: "dir", path: circuitsDir() }, { circuits: { ...PINNED_CIRCUITS, deposit: depositCircuit() } })
	const pool = poolConfig(env)

	return {
		client,
		async mint(to: Address, amount: bigint) {
			const abi = parseAbi(["function mint(address to, uint256 amount)"])
			await mined(await deployer.writeContract({ address: env.asset, abi, functionName: "mint", args: [to, amount] }))
		},
		async deployStub(): Promise<Address> {
			const out = join(PACKAGE_DIR, "../pp-env/contracts/out/StubProcessor.sol/StubProcessor.json")
			const { abi, bytecode } = JSON.parse(readFileSync(out, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } }
			const hash = await deployer.deployContract({ abi, bytecode: bytecode.object, args: [env.deployment.pool, env.asset] })
			return (await mined(hash)).contractAddress!
		},
		/** Anvil account `index` as a pool user, with a wallet for its own registration and deposits. */
		async user(index: number) {
			const account = anvilAccount(index)
			const signature = await derivationSignature(index)
			const { session } = await createSession({
				pool,
				owner: account.address,
				keys: deriveKeys(account.address, signature),
				artifacts,
				publicClient: client as never,
				wallet: walletOf(index) as never,
			})
			return {
				address: account.address,
				signature,
				async register() {
					const receipts = await session.registerKeystore()
					if (receipts.some((r) => !r.status)) throw new Error("keystore registration reverted")
				},
				async deposit(value: bigint): Promise<{ label: bigint; commitment: bigint }> {
					const prepared = await session.prepareDeposit({ tokenId: env.asset, value: toHex(value) })
					if (!(await session.executeDeposit(prepared)).status) throw new Error("deposit reverted")
					return { label: BigInt(prepared.pendingNote.label), commitment: BigInt(prepared.pendingNote.commitment) }
				},
			}
		},
		/** Adds the label to the mock ASP's set and publishes the new root on chain. */
		async approveLabel(label: bigint) {
			const res = await fetch(`${env.aspUrl}/admin/approve-label`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: toHex(label, { size: 32 }) }),
			})
			if (!res.ok) throw new Error(`approve-label: HTTP ${res.status}`)
		},
		async simulate(stub: Address, spend: PreparedSpend, fromIndex: number): Promise<Simulation> {
			try {
				await client.simulateContract({
					account: anvilAccount(fromIndex),
					address: stub,
					abi: SPEND_ABI,
					functionName: "spend",
					args: spendArgs(spend),
				})
				return { ok: true }
			} catch (err) {
				const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null
				if (!(revert instanceof ContractFunctionRevertedError)) throw err
				return { ok: false, errorName: revert.data?.errorName, raw: revert.raw }
			}
		},
		/** Sends the spend through `stub` and returns what the stub says it processed. */
		async submit(stub: Address, spend: PreparedSpend, fromIndex: number) {
			const hash = await walletOf(fromIndex).writeContract({
				address: stub,
				abi: SPEND_ABI,
				functionName: "spend",
				args: spendArgs(spend),
			})
			const logs = (await mined(hash)).logs.filter((l) => isAddressEqual(l.address, stub))
			const [processed] = parseEventLogs({ abi: STUB_PROCESSOR_ABI, eventName: "Processed", logs })
			if (processed === undefined) throw new Error(`${hash}: the stub emitted no Processed event`)
			return processed.args
		},
		async stubState(stub: Address) {
			return {
				balance: await client.readContract({ address: env.asset, abi: erc20Abi, functionName: "balanceOf", args: [stub] }),
				spends: await client.readContract({ address: stub, abi: STUB_PROCESSOR_ABI, functionName: "spendCount" }),
			}
		},
		/** Chain time moves only with blocks: jump the clock, then mine one. */
		async advance(seconds: number) {
			const test = createTestClient({ chain, transport, mode: "anvil" })
			await test.increaseTime({ seconds })
			await test.mine({ blocks: 1 })
		},
	}
}

export type Seeder = ReturnType<typeof seeder>
