// canary <deployment file> --min-sequence <s> --post <txHash> [--rehearse <manifest>]
// canary <deployment file> --settle <l2TxHash>... [--rehearse <manifest>]
// The first form runs the canary with the owner's and the sender's keys: bridge, deploy and claim,
// checked spends of the pool label and of a shielded birth, a full ragequit to the owner, and the
// settle of every burn. The second settles the listed burns' tickets to the canary owner with the
// sender's key alone. Exits 0 on a pass, 1 on a failure, 2 on a refusal, 3 when no epoch proof covered
// a burn within 75 min; exits 1 and 3 list every unsettled burn hash. Once the file loads, each writes
// `report.json` to its run directory on every outcome, an interrupt included.
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { BridgeClientError } from "@pp/bridge-core"
import { type Hex, isAddressEqual, type PublicClient } from "viem"
import { l1AddressOf } from "../accounts"
import { canaryArgs, CANARY_OPTIONS, type CanaryArgs } from "../canary/args"
import { bridgeClientOf, type CanaryContext, type ExitContext, type Full, unsettledOf } from "../canary/context"
import type { Burn } from "../canary/exits"
import { DEFAULT_SHIELD, runCanary } from "../canary/run"
import { settleListed } from "../canary/settle"
import { liveSpendIo } from "../checked-transfer"
import { GuardError, type Mode, readKeys } from "../guards"
import { RUN_KEYS } from "../keys"
import { loopback } from "../network"
import { CanaryError, CanaryReport, outcomeOf } from "../report"
import { cliArgs, report as emit, guarded, loadDeployment, logLine, main, runDir } from "./common"
import { assertOwnTarget } from "./context"
import { l1Wallet } from "./wallet"

type State = { burns: Burn[]; settled: Set<string> }

const SECTIONS = ["expected", "pool", "bridge"] as const

function exitContext(
	g: { d: Full; l1: PublicClient; node: AztecNode | undefined },
	sender: ExitContext["sender"],
	r: CanaryReport,
	s: State,
): ExitContext {
	if (!g.node) throw new GuardError("node", "the canary needs the Aztec node")
	return { ...g, node: g.node, client: bridgeClientOf(g.d), sender, payee: g.d.expected.canaryOwner, report: r, ...s, log: logLine }
}

async function canary(file: string, mode: Mode, a: Extract<CanaryArgs, { kind: "run" }>, r: CanaryReport, s: State): Promise<void> {
	const g = await guarded(file, mode, SECTIONS, true)
	const { d } = g
	assertOwnTarget(d)
	const shield = d.expected.amounts.shield ?? DEFAULT_SHIELD
	if (shield < 1n || shield > d.expected.amounts.bridge)
		throw new GuardError("amounts", `amounts.shield ${shield} must lie in [1, amounts.bridge]`)
	const keys = readKeys(RUN_KEYS.canary, mode, { env: process.env }, l1AddressOf)
	const ownerKey = keys.CANARY_OWNER_KEY as Hex
	const owner = l1AddressOf(ownerKey)
	if (!isAddressEqual(owner, d.expected.canaryOwner))
		throw new GuardError("account", `the owner key is for ${owner}, the file expects ${d.expected.canaryOwner}`)
	const sender = l1Wallet(d, keys.CANARY_SENDER_KEY as Hex, "canary sender", d.expected.canarySender)
	if (isAddressEqual(sender.account.address, owner)) throw new GuardError("account", "the canary sender is the owner")
	const base = exitContext(g, sender, r, s)
	const spendIo = liveSpendIo({
		node: base.node,
		l1: g.l1,
		aztecNode: d.network.aztecNode,
		registry: d.bridge.registry.toLowerCase() as Hex,
		aspRegistry: d.pool.aspRegistry,
		botUrl: loopback(d.network.botPort),
	})
	const c: CanaryContext = { ...base, ownerKey, minSequence: a.minSequence, postHash: a.post, spendIo }
	await runCanary(c)
}

async function settle(file: string, mode: Mode, r: CanaryReport, s: State): Promise<void> {
	const g = await guarded(file, mode, SECTIONS, true)
	assertOwnTarget(g.d)
	const key = readKeys(RUN_KEYS["canary-settle"], mode, { env: process.env }, l1AddressOf).CANARY_SENDER_KEY as Hex
	const sender = l1Wallet(g.d, key, "canary sender", g.d.expected.canarySender)
	await settleListed(exitContext(g, sender, r, s))
}

/** A failure's printable cause: the client's code, the canary's and the guards' own words, else the error's first line. */
function describe(e: unknown): string {
	if (e instanceof BridgeClientError || e instanceof CanaryError || e instanceof GuardError) return e.message
	return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : "failed"
}

/** Step 11: the report, on every outcome; exits 1 and 3 list every unsettled burn. */
function finish(r: CanaryReport, s: State, failure: unknown): number {
	const outcome = outcomeOf(failure)
	const unsettled = unsettledOf(s)
	if (outcome.exitCode !== 0 && unsettled.length) {
		r.set("unsettled", unsettled)
		emit("unsettled", { burns: unsettled.join(" ") })
	}
	const path = r.finish(outcome)
	if (failure !== undefined) logLine(`${outcome.exitClass === "REFUSED" ? "refused" : "failed"}: ${describe(failure)}`)
	emit("canary-report", { path, exitClass: outcome.exitClass, exitCode: outcome.exitCode })
	return outcome.exitCode
}

await main(async () => {
	const { file, mode, values, rest } = cliArgs(process.argv.slice(2), CANARY_OPTIONS)
	const a = canaryArgs(mode, values, rest)
	const d = loadDeployment(file)
	const command = a.kind === "run" ? "canary" : "canary-settle"
	const dir = runDir(d, `${command}-${new Date().toISOString().replace(/[:.]/g, "-")}`, mode)
	const r = new CanaryReport(dir, { command, target: d.target, l1ChainId: d.network.l1ChainId })
	const s: State = { burns: a.kind === "settle" ? a.burns.map((txHash) => ({ txHash })) : [], settled: new Set() }
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => process.exit(finish(r, s, new CanaryError("FAILED", "INTERRUPTED", `stopped by ${signal}`))))
	try {
		await (a.kind === "run" ? canary(file, mode, a, r, s) : settle(file, mode, r, s))
	} catch (e) {
		return finish(r, s, e)
	}
	return finish(r, s, undefined)
})
