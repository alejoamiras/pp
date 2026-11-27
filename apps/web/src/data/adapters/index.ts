/**
 * The stack behind `#data`: the deployment and endpoints from the build's stack target, Ethereum
 * through the page's injected wallet, chain time from both chains, and the owner's session over
 * pool-client and the bridge client. The Aztec, exit and allow-list ports have no stack adapter yet
 * and refuse.
 */
import { getAddress } from "viem"
import { target } from "../../target"
import { stageManifest } from "../capabilities"
import { parseAztecAddress } from "../parse"
import type { AllowListPort, AztecPort, Deployment, ExitPort, SessionPort } from "../ports"
import type { DataSource } from "../source"
import type { AztecAddress } from "../stack-types"
import { browserTimer } from "../timer"
import { loadRealConnector } from "../wallet/load"
import { stackClock } from "./clock"
import { type InjectedWallet, stackL1 } from "./l1"

const unavailable = (port: string) => (): Promise<never> => Promise.reject(new Error(`${port} has no stack adapter in this build`))

const stack = target.stack
if (stack === null) throw new Error("a stack build was built without a stack target")
const { manifest } = stack

function aztecAddress(value: string, field: string): AztecAddress {
	const parsed = parseAztecAddress(value)
	if (parsed === null) throw new Error(`stack target: ${field} is not an Aztec address`)
	return parsed
}

/**
 * The asset's decimals and symbol are not read from chain yet: 6 is the local stack's test token's,
 * and the symbol stays empty rather than guessed.
 */
const deployment: Deployment = {
	id: `${manifest.chainId}:${manifest.bridge.portal.toLowerCase()}:${manifest.bridge.hub.toLowerCase()}`,
	chainId: manifest.chainId,
	stage: "2a",
	portal: getAddress(manifest.bridge.portal),
	hub: aztecAddress(manifest.bridge.hub, "bridge.hub"),
	token: aztecAddress(manifest.bridge.token, "bridge.token"),
	sponsoredFpc: aztecAddress(stack.sponsoredFpc, "sponsoredFpc"),
	decimals: 6,
	symbol: "",
}

const l1 = stackL1(target, (globalThis as { ethereum?: InjectedWallet }).ethereum)

type Sessions = Promise<SessionPort>
let sessionsLoad: Sessions | undefined
/** The session module and the page's prover load on first use; proving files come from this page's own server. */
const loadSessions = (): Sessions =>
	(sessionsLoad ??= import("./session").then((m) =>
		m.stackSessions({
			manifest,
			reads: l1.reads,
			prover: m.proverFor(browserTimer),
			artifacts: { kind: "gateway", urls: [location.origin] },
		}),
	))

const sessions: SessionPort = {
	open: async (a) => (await loadSessions()).open(a),
	forget: async () => (await loadSessions()).forget(),
}

const aztec: AztecPort = {
	balancesByLabel: unavailable("AztecPort.balancesByLabel"),
	notesByLabel: unavailable("AztecPort.notesByLabel"),
	publicBalance: unavailable("AztecPort.publicBalance"),
	transferPrivate: unavailable("AztecPort.transferPrivate"),
	unshield: unavailable("AztecPort.unshield"),
	shield: unavailable("AztecPort.shield"),
	ragequit: unavailable("AztecPort.ragequit"),
	exitPublic: unavailable("AztecPort.exitPublic"),
}
const exits: ExitPort = { tickets: unavailable("ExitPort.tickets"), settle: unavailable("ExitPort.settle") }
const allowList: AllowListPort = {
	current: unavailable("AllowListPort.current"),
	state: () => {
		throw new Error("AllowListPort.state has no stack adapter in this build")
	},
}

export const source: DataSource = {
	mode: "stack",
	deployment,
	clock: stackClock(l1.reads, target.nodeUrl),
	timer: browserTimer,
	l1,
	sessions,
	aztec,
	exits,
	allowList,
	wallet: () => loadRealConnector(stageManifest(deployment.stage, deployment)),
}
