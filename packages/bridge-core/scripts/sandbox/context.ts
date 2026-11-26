/** The per-actor context a flow runs in, and the helpers every flow shares. Nothing here is module
 *  state, so two actors (two test files) never see each other's state. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { Address } from "viem"
import type { L1Ctx } from "../../src/flows"
import { claimViaHub } from "../../src/hub-l2"
import type { JournalTokenBlock } from "../../src/journal"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { type L2Ctx, waitForL1ToL2Message } from "../generation"
import { claimTokensUntilSynced, registerHub, registerHubToken } from "../script-l2"
import { depositViaPortal, type PortalDepositResult } from "./deposit"
import type { SandboxClients } from "./handle"
import { l2CtxFor } from "./l2"

// ─── Context ─────────────────────────────────────────────────────────────────

export interface SmokeContext {
	clients: SandboxClients
	l1: L1Ctx
	/** A second L1 account, for the flows that need two depositors. */
	l1b: L1Ctx
	l2: L2Ctx
	relayer: AztecAddress
	relayerOpts: Record<string, unknown>
	/** Sends as the hub's guardian — the base actor that deployed the generation. */
	guardianOpts: Record<string, unknown>
	manifest: ManifestV2
	bridge: BridgeBlock
	hub: ContractBase
	/** Every fresh token the battery deploys, so a later flow can read its L2 balance. */
	l2TokenOf: (block: JournalTokenBlock) => Promise<ContractBase>
	mins: () => string
}

/** A context whose actor is `from`. Each test file (each actor) builds its own. */
export async function buildContext(clients: SandboxClients, manifest: ManifestV2, from: AztecAddress): Promise<SmokeContext> {
	const bridge = manifest.bridge as BridgeBlock
	const hub = await registerHub(clients.l2.wallet, bridge.l2.hub)
	const hubAddress = AztecAddress.fromStringUnsafe(bridge.l2.hub.address)
	const known = new Map<string, ContractBase>()
	return {
		clients,
		l1: clients.l1,
		l1b: clients.l1b,
		l2: l2CtxFor(clients.l2, from),
		relayer: clients.l2.relayer,
		relayerOpts: clients.l2.relayerOpts,
		guardianOpts: clients.l2.guardianOpts,
		manifest,
		bridge,
		hub,
		l2TokenOf: async (block) => {
			const cached = known.get(block.erc20.toLowerCase())
			if (cached) return cached
			const contract = await registerHubToken(
				clients.l2.wallet,
				hubAddress,
				tokenFromBlock(block, block.decimals),
				bridge.l2.tokenClassId,
			)
			known.set(block.erc20.toLowerCase(), contract)
			return contract
		},
		mins: clients.mins,
	}
}

// ─── Token shapes ────────────────────────────────────────────────────────────

/** The ManifestToken shape for a token this run invented — the factory read-back is the authority. */
export function tokenFromBlock(block: JournalTokenBlock, decimals: number): ManifestToken {
	return {
		erc20: block.erc20,
		portal: block.portal,
		l2Token: block.l2Token,
		nameWord: block.nameWord,
		symbolWord: block.symbolWord,
		decimals,
		displayName: block.displaySymbol,
		displaySymbol: block.displaySymbol,
		source: "permissionless-mint",
		sourceContract: "MintableERC20",
	}
}

export const tokenBlockOf = (t: ManifestToken): JournalTokenBlock => ({
	erc20: t.erc20,
	portal: t.portal,
	l2Token: t.l2Token,
	nameWord: t.nameWord,
	symbolWord: t.symbolWord,
	decimals: t.decimals,
	displaySymbol: t.displaySymbol,
})

export const registerArgsOf = (block: JournalTokenBlock, nameWord: string) =>
	[
		EthAddress.fromString(block.erc20),
		EthAddress.fromString(block.portal),
		Fr.fromHexString(nameWord),
		Fr.fromHexString(block.symbolWord),
		block.decimals,
		new Fr(BigInt(block.registerIndex as string)),
	] as const

// ─── Reads ───────────────────────────────────────────────────────────────────

/** A send resolves when the node has the block; a read through the wallet's own PXE can trail
 *  that block by a sync tick. A value a transaction is expected to move is polled until it has —
 *  bounded, so a transaction that never landed still fails loudly with the last figure read. */
export async function settled<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
	const until = Date.now() + ms
	let value = await read()
	while (!done(value)) {
		if (Date.now() > until) throw new Error(`${what} never settled — last read ${String(value)}`)
		await new Promise((r) => setTimeout(r, 500))
		value = await read()
	}
	return value
}

export async function balanceOf(contract: ContractBase, from: AztecAddress, kind: "public" | "private"): Promise<bigint> {
	const call = kind === "public" ? contract.methods.balance_of_public(from) : contract.methods.balance_of_private(from)
	const r = (await call.simulate({ from } as never)) as { result?: bigint } | bigint
	return typeof r === "bigint" ? r : (r.result ?? 0n)
}

// ─── Deposits and claims ─────────────────────────────────────────────────────

/** A direct portal deposit from `l1` (default: the harness) to `recipient`. */
export function deposit(
	s: SmokeContext,
	p: { erc20: Address; amount: bigint; recipient: AztecAddress; isPrivate: boolean },
	l1: L1Ctx = s.l1,
): Promise<PortalDepositResult> {
	return depositViaPortal(l1, {
		factory: s.bridge.l1.factory as Address,
		hub: s.bridge.l2.hub.address,
		tokenClassId: s.bridge.l2.tokenClassId,
		erc20: p.erc20,
		amount: p.amount,
		recipient: p.recipient.toString(),
		isPrivate: p.isPrivate,
	})
}

/** A public deposit of a token this run invented: to the actor from the harness, to the relayer from the second account. */
export function depositFresh(s: SmokeContext, erc20: Address, amount: bigint, l1: L1Ctx = s.l1): Promise<PortalDepositResult> {
	return deposit(s, { erc20, amount, recipient: l1 === s.l1 ? s.l2.from : s.relayer, isPrivate: false }, l1)
}

export interface ClaimPlan {
	amount: bigint
	isPrivate: boolean
	recipient: AztecAddress
	submitter?: "relayer"
}

/** The claim's token block always comes from the factory read-back the deposit returned — the
 *  manifest copy would be missing for a token this run just invented. */
function claimInputs(s: SmokeContext, res: PortalDepositResult, p: ClaimPlan) {
	const sendOpts = p.submitter === "relayer" ? s.relayerOpts : s.l2.sendOpts
	return {
		hub: s.hub,
		claim: {
			token: res.token,
			recipient: p.recipient.toString(),
			amount: p.amount,
			claimValue: Fr.fromHexString(res.claimValueHex),
			leafIndex: res.leafIndex,
			isPrivate: p.isPrivate,
			from: (sendOpts.from as AztecAddress).toString(),
		},
		sendOpts,
	}
}

export async function claim(s: SmokeContext, res: PortalDepositResult, p: ClaimPlan) {
	// A first claim registers the token, which enqueues the derived Token's constructor — the wallet
	// has to hold that instance to build the transaction at all.
	await s.l2TokenOf(res.token)
	// Waiting for the deposit's own message first turns the retry loop into a fallback rather than
	// the normal path, which keeps a genuinely-rejected claim from spending minutes in it.
	await waitForL1ToL2Message(s.l2.node, res.messageHashHex, { forceBlock: s.l2.forceBlock })
	return claimTokensUntilSynced({ ...claimInputs(s, res, p), attempts: 60, intervalMs: 3000 })
}

/** One attempt, no sync retry — for the claims that are SUPPOSED to fail. */
export async function claimOnce(s: SmokeContext, res: PortalDepositResult, p: ClaimPlan) {
	const { hub, claim: params, sendOpts } = claimInputs(s, res, p)
	return claimViaHub(hub, params, sendOpts)
}
