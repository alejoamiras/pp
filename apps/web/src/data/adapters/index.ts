/**
 * The stack behind `#data`: the deployment and endpoints from the build's stack target, the asset's
 * decimals and symbol from the factory's registration, Ethereum through the page's injected wallet, chain time from both chains, the owner's session over
 * pool-client and the bridge client, the token's views and the ragequit through the connected Aztec
 * wallet, and exit tickets over the bridge client. The allow-list port has no stack adapter yet and refuses.
 *
 * Everything that carries aztec.js, the contract artifacts or the bridge client loads on first use,
 * so the main chunk stays free of them.
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

const unavailable = (port: string) => (): Promise<never> => Promise.reject(new Error(`${port} has no stack adapter in this build`))

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
	stage: "2a",
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

type AztecSide = { deps: AztecDeps; port: Pick<AztecPort, "balancesByLabel" | "notesByLabel"> }
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

type ExitSide = Pick<AztecPort, "ragequit"> & ExitPort
let exitsLoad: Promise<ExitSide> | undefined
const loadExits = (): Promise<ExitSide> =>
	(exitsLoad ??= Promise.all([import("./session"), loadAztec()]).then(([m, side]) =>
		m.stackExits({ manifest, deployment, aztec: side.deps, notes: (owner, label) => side.port.notesByLabel(owner, label), l1 }),
	))

const sessions: SessionPort = {
	open: async (a) => (await loadSessions()).open(a),
	forget: async () => (await loadSessions()).forget(),
}

const aztec: AztecPort = {
	balancesByLabel: async (owner) => (await loadAztec()).port.balancesByLabel(owner),
	notesByLabel: async (owner, label) => (await loadAztec()).port.notesByLabel(owner, label),
	publicBalance: unavailable("AztecPort.publicBalance"),
	transferPrivate: unavailable("AztecPort.transferPrivate"),
	unshield: unavailable("AztecPort.unshield"),
	shield: unavailable("AztecPort.shield"),
	ragequit: async (from, a, on) => (await loadExits()).ragequit(from, a, on),
	exitPublic: unavailable("AztecPort.exitPublic"),
}
const exits: ExitPort = {
	tickets: async (payee) => (await loadExits()).tickets(payee),
	settle: async (t, sender, on) => (await loadExits()).settle(t, sender, on),
}
const allowList: AllowListPort = {
	current: unavailable("AllowListPort.current"),
	state: () => {
		throw new Error("AllowListPort.state has no stack adapter in this build")
	},
}

const ports: Omit<DataSource, "deployment"> = {
	mode: "stack",
	clock: stackClock(l1.reads, target.nodeUrl),
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
