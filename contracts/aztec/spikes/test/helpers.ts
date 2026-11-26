import { readFileSync } from "node:fs"
import { cpus } from "node:os"
import { join } from "node:path"
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing/lazy"
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node"
import type { TxProfileResult } from "@aztec-labs/stdlib/tx"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { createFundedInitializerlessAccounts } from "@aztec-labs/wallets/testing"

export interface Actor {
	wallet: EmbeddedWallet
	address: AztecAddress
	node: AztecNode
}

/**
 * A wallet with its own PXE holding exactly one genesis account. A PXE treats every account it holds as an implicit
 * tag sender, so actors must never share accounts or discovery tests prove nothing.
 */
export async function actor(nodeUrl: string, accountIndex: number, opts: { proverEnabled?: boolean } = {}): Promise<Actor> {
	const node = createAztecNodeClient(nodeUrl)
	const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: opts.proverEnabled ?? false } })
	const data = await getInitialTestAccountsData()
	const account = data[accountIndex]
	if (!account) throw new Error(`no genesis account ${accountIndex}`)
	const [manager] = await createFundedInitializerlessAccounts(wallet, [account])
	if (!manager) throw new Error("account creation returned nothing")
	return { wallet, address: manager.address, node }
}

export function artifact(file: string): ContractArtifact {
	return loadContractArtifact(JSON.parse(readFileSync(join(import.meta.dirname, "..", "target", file), "utf8")))
}

/** One line per measurement, grep-able from the test log and copied into the findings. */
export function record(name: string, data: Record<string, unknown>): void {
	console.log(`MEASURE ${name} ${JSON.stringify({ ...data, cores: cpus().length, hardwareConcurrency: process.env.HARDWARE_CONCURRENCY ?? null })}`)
}

/** Per-circuit gates of a whole transaction (app functions and kernels) plus the client proving time. */
export function summarizeProfile(p: TxProfileResult) {
	return {
		steps: p.executionSteps.map((s) => ({ fn: s.functionName, gates: s.gateCount ?? s.timings.gateCount ?? null })),
		totalGates: p.executionSteps.reduce((n, s) => n + (s.gateCount ?? s.timings.gateCount ?? 0), 0),
		provingMs: p.stats.timings.proving ?? null,
		witgenMs: p.stats.timings.perFunction.reduce((n, f) => n + f.time, 0),
		totalMs: p.stats.timings.total,
	}
}
