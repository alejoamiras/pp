/**
 * The stack behind `#data`: the deployment and endpoints from the build's stack target, the asset's
 * decimals and symbol from the factory's registration, Ethereum through the page's injected wallet, chain time from both chains, the owner's session over
 * pool-client and the bridge client, the token's views, its checked spends and the ragequit through
 * the connected Aztec wallet, exit tickets over the bridge client, and the allow list from the
 * registry's record and the bot's snapshots, checked in a worker.
 *
 * Everything that carries aztec.js, the contract artifacts, the bridge client or the allow list's
 * reader loads on first use, so the main chunk stays free of them.
 */
import { demoSender } from "#demo-sender"
import { getAddress } from "viem"
import { target } from "../../target"
import { stageManifest } from "../capabilities"
import { parseAztecAddress } from "../parse"
import type { AllowListPort, AztecPort, Deployment, ExitPort, SessionPort } from "../ports"
import type { DataSource } from "../source"
import type { AztecAddress } from "../stack-types"
import { browserTimer } from "../timer"
import type { HeldWallet, RealConnector } from "../wallet/connector"
import { loadRealConnector } from "../wallet/load"
import type { AztecDeps } from "./aztec"
import { stackClock } from "./clock"
import { type InjectedWallet, stackL1 } from "./l1"
import { readToken } from "./token"

const stack = target.stack
if (stack === null) throw new Error("a stack build was built without a stack target")
const { manifest } = stack

function aztecAddress(value: string, field: string): AztecAddress {
	const parsed = parseAztecAddress(value)
	if (parsed === null) throw new Error(`stack target: ${field} is not an Aztec address`)
	return parsed
}

/** The deployment as the manifest names it; the asset's decimals and symbol come from the chain at load. */
const deployment: Omit<Deployment, "decimals" | "symbol"> = {
	id: `${manifest.chainId}:${manifest.bridge.portal.toLowerCase()}:${manifest.bridge.hub.toLowerCase()}`,
	chainId: manifest.chainId,
	stage: "2e",
	portal: getAddress(manifest.bridge.portal),
	hub: aztecAddress(manifest.bridge.hub, "bridge.hub"),
	token: aztecAddress(manifest.bridge.token, "bridge.token"),
	sponsoredFpc: aztecAddress(stack.sponsoredFpc, "sponsoredFpc"),
}

// A local-stack build bundles the demo sender here; every other build bundles the throwing stub.
const demo = stack.demoSender
	? demoSender({ l1RpcUrl: manifest.l1Rpc, chainId: manifest.chainId, portal: deployment.portal, address: getAddress(stack.demoSender) })
	: null
const l1 = stackL1(target, (globalThis as { ethereum?: InjectedWallet }).ethereum, demo)

/** One connector per page: the adapters send only through the wallet it holds for the live connection. */
let connector: RealConnector | null = null
let connectorLoad: Promise<RealConnector> | undefined
const loadConnector = (): Promise<RealConnector> =>
	(connectorLoad ??= loadRealConnector(stageManifest(deployment.stage, deployment)).then((c) => (connector = c)))
const current = (): HeldWallet | null => connector?.current() ?? null

type AztecSide = { deps: AztecDeps; port: Pick<AztecPort, "balancesByLabel" | "notesByLabel" | "publicBalance"> }
let aztecLoad: Promise<AztecSide> | undefined
const loadAztec = (): Promise<AztecSide> =>
	(aztecLoad ??= import("./aztec").then((m) => {
		const deps = m.aztecDeps(target.nodeUrl, deployment, current)
		return { deps, port: m.stackAztec(deps) }
	}))

let sessionsLoad: Promise<SessionPort> | undefined
/** The session module and the page's prover load on first use; proving files come from this page's own server. */
const loadSessions = (): Promise<SessionPort> =>
	(sessionsLoad ??= Promise.all([import("./session"), loadAztec()]).then(([m, side]) =>
		m.stackSessions({
			manifest,
			reads: l1.reads,
			prover: m.proverFor(browserTimer),
			artifacts: { kind: "gateway", urls: [location.origin] },
			l1,
			aztec: side.deps,
			storage: localStorage,
		}),
	))

type ExitSide = {
	exits: Pick<AztecPort, "ragequit"> & ExitPort
	withdraw: Pick<AztecPort, "exitPublic" | "exitPrivate">
}
let exitsLoad: Promise<ExitSide> | undefined
/** The exits and the withdrawals share one bridge client, in the chunk the build lets carry it. */
const loadExits = (): Promise<ExitSide> =>
	(exitsLoad ??= Promise.all([import("./session"), loadAztec()]).then(([m, side]) => {
		const client = m.exitClient(manifest)
		const notes: AztecPort["notesByLabel"] = (owner, label) => side.port.notesByLabel(owner, label)
		return {
			exits: m.stackExits({ manifest, deployment, aztec: side.deps, notes, l1, client }),
			withdraw: m.stackWithdraw({
				aztec: side.deps,
				allowList,
				sponsoredFpc: deployment.sponsoredFpc,
				client,
				notes,
				publicBalance: (owner) => side.port.publicBalance(owner),
			}),
		}
	}))

type SendSide = Pick<AztecPort, "transferPrivate" | "unshield" | "shield">
let sendsLoad: Promise<SendSide> | undefined
const loadSends = (): Promise<SendSide> =>
	(sendsLoad ??= Promise.all([import("./token-sends"), loadAztec()]).then(([m, side]) =>
		m.stackTokenSends({
			aztec: side.deps,
			allowList,
			sponsoredFpc: deployment.sponsoredFpc,
			notes: (owner, label) => side.port.notesByLabel(owner, label),
			publicBalance: (owner) => side.port.publicBalance(owner),
		}),
	))

const sessions: SessionPort = {
	open: async (a) => (await loadSessions()).open(a),
	forget: async () => (await loadSessions()).forget(),
}

const aztec: AztecPort = {
	balancesByLabel: async (owner) => (await loadAztec()).port.balancesByLabel(owner),
	notesByLabel: async (owner, label) => (await loadAztec()).port.notesByLabel(owner, label),
	publicBalance: async (owner) => (await loadAztec()).port.publicBalance(owner),
	transferPrivate: async (from, a, on) => (await loadSends()).transferPrivate(from, a, on),
	unshield: async (from, a, on) => (await loadSends()).unshield(from, a, on),
	shield: async (from, amount, on) => (await loadSends()).shield(from, amount, on),
	ragequit: async (from, a, on) => (await loadExits()).exits.ragequit(from, a, on),
	exitPublic: async (from, a, on) => (await loadExits()).withdraw.exitPublic(from, a, on),
	exitPrivate: async (from, a, on) => (await loadExits()).withdraw.exitPrivate(from, a, on),
}
const exits: ExitPort = {
	tickets: async (payee) => (await loadExits()).exits.tickets(payee),
	settle: async (t, from, on) => (await loadExits()).exits.settle(t, from, on),
}
/** The allow list loads on first use; its worker starts at the first check. */
let allowLoad: Promise<AllowListPort> | undefined
let allowPort: AllowListPort | null = null
const progress = new Set<Parameters<AllowListPort["onProgress"]>[0]>()
const loadAllowList = (): Promise<AllowListPort> =>
	(allowLoad ??= import("./allow-list").then((m) => {
		const port = m.stackAllowList({
			nodeUrl: target.nodeUrl,
			registry: aztecAddress(manifest.bridge.registry, "bridge.registry"),
			botUrl: stack.botUrl,
			timer: browserTimer,
			worker: m.browserWorker,
		})
		port.onProgress((p) => {
			for (const f of [...progress]) f(p)
		})
		allowPort = port
		return port
	}))

const allowList: AllowListPort = {
	current: async () => (await loadAllowList()).current(),
	check: async (view, label, origin) => (await loadAllowList()).check(view, label, origin),
	onProgress(f) {
		progress.add(f)
		return () => void progress.delete(f)
	},
	cancel: () => allowPort?.cancel(),
	checkAgain: (view) => allowPort?.checkAgain(view) ?? true,
}

const ports: Omit<DataSource, "deployment"> = {
	mode: "stack",
	clock: stackClock(l1.reads, target.nodeUrl),
	receipts: { aztec: async (txHash) => (await import("./aztec")).readReceipt((await loadAztec()).deps.node, txHash) },
	timer: browserTimer,
	l1,
	sessions,
	aztec,
	exits,
	allowList,
	wallet: loadConnector,
}

let loading: Promise<DataSource> | undefined
/** The source once the factory's registration confirms the manifest's portal; a failed read is retried on the next call. */
export const loadSource = (): Promise<DataSource> =>
	(loading ??= readToken(l1.reads, {
		factory: getAddress(manifest.bridge.factory),
		asset: getAddress(manifest.pool.asset),
		portal: deployment.portal,
	}).then(
		(token) => ({ ...ports, deployment: { ...deployment, ...token } }),
		(err: unknown) => {
			loading = undefined
			throw err
		},
	))
