/**
 * The stack behind `#data`: the real wallet connector, and ports that refuse until their packages land.
 * The deployment is a placeholder with zero addresses: no build serves this data mode yet, and the
 * stack-build check only proves that no fixture module is reachable from it.
 */
import { target } from "../../target"
import type { AztecAddress } from "../stack-types"
import { stageManifest } from "../capabilities"
import type { AllowListPort, AztecPort, Deployment, ExitPort, L1Port, SessionPort } from "../ports"
import type { DataSource } from "../source"
import { browserTimer } from "../timer"
import { loadRealConnector } from "../wallet/load"

const unavailable = (port: string) => (): Promise<never> => Promise.reject(new Error(`${port} has no stack adapter in this build`))
const ZERO_AZTEC = `0x${"0".repeat(64)}` as AztecAddress
const ZERO_L1 = `0x${"0".repeat(40)}` as const

const deployment: Deployment = {
	id: `${target.l1ChainId}:${ZERO_L1}:${ZERO_AZTEC}`,
	chainId: target.l1ChainId,
	stage: "2a",
	portal: ZERO_L1,
	hub: ZERO_AZTEC,
	token: ZERO_AZTEC,
	sponsoredFpc: ZERO_AZTEC,
	decimals: 6,
	symbol: "",
}

const l1: L1Port = {
	accounts: unavailable("L1Port.accounts"),
	chainId: unavailable("L1Port.chainId"),
	signTypedData: unavailable("L1Port.signTypedData"),
	onAccountsChanged: () => () => {},
	onChainChanged: () => () => {},
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
const sessions: SessionPort = { open: unavailable("SessionPort.open"), forget: unavailable("SessionPort.forget") }
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
	clock: { aztecNow: unavailable("ChainClock.aztecNow"), l1Now: unavailable("ChainClock.l1Now") },
	timer: browserTimer,
	l1,
	sessions,
	aztec,
	exits,
	allowList,
	wallet: () => loadRealConnector(stageManifest(deployment.stage, deployment)),
}
