// verify-deployment <deployment file> [--pool-only] [--bot] [--label <decimal> --min-sequence <n>] [--rehearse <manifest> | --rehearse-fork <url>]
// Read-only. --pool-only: the own pool's code against the build, its bindings, roles and asset config.
// Otherwise also the bridge: the factory's creation transaction, the token class, the registry roles,
// entries paused and `checkBeforeOpen`; with --bot, the record against the registry's root and its
// block; with --label, that label ACTIVE in the bot's latest snapshot at or after --min-sequence.
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { checkBeforeOpen } from "@pp/bridge-core/deploy"
import { labelState, parseAspSnapshot, readRootRecord } from "@pp/label-paths"
import { verifyPoolCode } from "@pp/pp-env/sepolia"
import { GuardError } from "../guards"
import { loopback, SEPOLIA } from "../network"
import type { TestnetDeployment } from "../schema"
import {
	checkDeployBlock,
	checkEntriesPaused,
	checkFactoryCreation,
	checkPoolBindings,
	checkRecordRoot,
	OWN_ASSET,
	VerifyError,
} from "../verify"
import { openContextOf } from "./context"
import { cliArgs, guarded, main, report } from "./common"

type WithPool = TestnetDeployment & Required<Pick<TestnetDeployment, "expected" | "pool">>
type Full = TestnetDeployment & Required<Pick<TestnetDeployment, "expected" | "pool" | "bridge">>

async function checkPool(d: WithPool, l1: Parameters<typeof checkPoolBindings>[0]): Promise<void> {
	const p = d.pool
	if (d.target === "own" && d.network.l1ChainId === SEPOLIA) {
		if (!p.accessRouter || !p.relay) throw new VerifyError("pool", "the own pool's section names no access router or relay")
		const deployment = { ...p, pool: p.poolVault, accessRouter: p.accessRouter, relay: p.relay }
		const matched = await verifyPoolCode({ rpcUrl: d.network.l1Rpc, chainId: SEPOLIA, deployment })
		report("pool-code", { matched: matched.length })
	}
	const o = d.operator?.asset
	const asset = o ? { minAmount: o.minDeposit, vettingFeeBps: BigInt(o.vettingFeeBps) } : OWN_ASSET
	await checkPoolBindings(l1, p, d.expected.aspPostman, asset)
	report("pool-bindings", { entrypoint: p.entrypoint, asset: p.asset })
	report("deploy-block", { deployBlock: p.deployBlock, initializedAt: await checkDeployBlock(l1, p) })
}

async function checkBridge(d: Full, l1: Parameters<typeof checkPoolBindings>[0], node: unknown): Promise<void> {
	const b = d.bridge
	await checkFactoryCreation(l1, b.factoryTx, b.factory, {
		deployer: d.expected.l1Deployer,
		registry: d.network.l1Registry,
		hub: b.hub,
		pool: d.pool.poolVault,
		lifetimeCap: d.expected.lifetimeCap,
		guardian: d.expected.guardian,
	})
	const n = node as { getContract(a: AztecAddress): Promise<{ currentContractClassId: { toString(): string } } | undefined> }
	const token = await n.getContract(AztecAddress.fromStringUnsafe(b.token))
	if (BigInt(token?.currentContractClassId.toString() ?? 0) !== BigInt(d.expected.tokenClassId))
		throw new VerifyError("token class", `${token?.currentContractClassId ?? "no contract"}, the file names ${d.expected.tokenClassId}`)
	await checkEntriesPaused(l1, b.factory)
	await checkBeforeOpen(openContextOf(d, l1, node))
	report("bridge", { factory: b.factory, token: b.token, paused: true })
}

async function checkBot(d: Full, l1: Parameters<typeof checkPoolBindings>[0], label?: bigint, minSequence?: bigint): Promise<void> {
	const record = await readRootRecord({ aztecNode: d.network.aztecNode, registry: d.bridge.registry })
	await checkRecordRoot(l1, d.pool.aspRegistry, record)
	report("bot-record", { sequence: record.sequence, l1Block: record.l1Block })
	if (label === undefined) return
	if (minSequence !== undefined && record.sequence < minSequence)
		throw new VerifyError("record sequence", `${record.sequence}, below --min-sequence ${minSequence}`)
	const res = await fetch(`${loopback(d.network.botPort)}/v1/snapshots/latest`, { signal: AbortSignal.timeout(10_000) })
	if (!res.ok) throw new VerifyError("bot snapshot", `HTTP ${res.status}`)
	const snapshot = parseAspSnapshot(await res.json())
	const state = labelState(record, snapshot, label, 0, BigInt(Math.floor(Date.now() / 1000)))
	if (state !== "ACTIVE") throw new VerifyError("label", `${label} is ${state} at sequence ${record.sequence}`)
	report("label", { label, state, sequence: record.sequence })
}

const decimalArg = (name: string, v: unknown): bigint | undefined => {
	if (v === undefined) return undefined
	if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw new GuardError("argv", `--${name} takes a decimal`)
	return BigInt(v)
}

await main(async () => {
	const { file, mode, values } = cliArgs(process.argv.slice(2), {
		"pool-only": { type: "boolean" },
		bot: { type: "boolean" },
		label: { type: "string" },
		"min-sequence": { type: "string" },
	})
	const label = decimalArg("label", values.label)
	const minSequence = decimalArg("min-sequence", values["min-sequence"])
	if (label !== undefined && !values.bot) throw new GuardError("argv", "--label reads the bot's snapshot: pass --bot too")
	if (values["pool-only"]) {
		const { d, l1 } = await guarded(file, mode, ["expected", "pool"], false)
		await checkPool(d, l1)
		return 0
	}
	const { d, l1, node } = await guarded(file, mode, ["expected", "pool", "bridge"], true)
	await checkPool(d, l1)
	await checkBridge(d, l1, node)
	if (values.bot) await checkBot(d, l1, label, minSequence)
	report("verified", { target: d.target })
	return 0
})
