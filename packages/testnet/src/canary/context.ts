import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { memoryJournal } from "@pp/bridge-core/account"
import { type BridgeClient, createBridgeClient, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import type { Address, Hex, PublicClient } from "viem"
import type { SpendIo } from "../checked-transfer"
import { toStackManifest } from "../manifest"
import type { CanaryReport } from "../report"
import type { TestnetDeployment } from "../schema"
import type { l1Wallet } from "../cli/wallet"
import type { Burn } from "./exits"

export type Full = TestnetDeployment & Required<Pick<TestnetDeployment, "expected" | "pool" | "bridge">>

/** Every L2 send the canary makes waits this long for its checkpoint. */
export const L2_WAIT_TIMEOUT_SEC = 600

/** What a run and `--settle` share: the clients, the report, the burns and which of them settled. */
export type ExitContext = {
	d: Full
	l1: PublicClient
	node: AztecNode
	client: BridgeClient
	/** Signs every L1 send; never the owner. */
	sender: ReturnType<typeof l1Wallet>
	/** The canary owner: every burn's payee. */
	payee: Address
	report: CanaryReport
	burns: Burn[]
	/** Lower-case L2 hashes of the burns settled. */
	settled: Set<string>
	/** The one budget every burn's epoch proof shares. */
	epochProofBudgetMs: number
	log(line: string): void
}

export type CanaryContext = ExitContext & {
	ownerKey: Hex
	minSequence: bigint
	postHash: Hex
	spendIo: SpendIo
}

/** The bridge client of the file's generation, at the public chain's timing in every mode. */
export const bridgeClientOf = (d: Full): BridgeClient =>
	createBridgeClient({ manifest: toStackManifest(d), journal: memoryJournal(), timing: PUBLIC_CHAIN_TIMING })

/** The burns not yet settled, in the order they were sent or listed. */
export const unsettledOf = (c: Pick<ExitContext, "burns" | "settled">): Hex[] =>
	c.burns.map((b) => b.txHash).filter((h) => !c.settled.has(h.toLowerCase()))
