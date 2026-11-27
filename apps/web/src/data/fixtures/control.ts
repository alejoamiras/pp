/**
 * `window.__ppFixtures`: how tests and the demo drive the fixture world. Fixture builds only; a stack
 * build that names it fails the guard. Inputs are checked, since any page script can call it.
 */
import { type Address, isAddress } from "viem"
import type { StaleRootCode } from "../stack-types"
import { approveBirths, resetAllowList } from "./allow-list"
import { type FixtureOp, isFixtureOp } from "./faults"
import { selectedAccount } from "./l1"
import { ACCOUNTS } from "./seed"
import type { World } from "./world"

const STALE_CODES: readonly StaleRootCode[] = ["STATE_ROOT_STALE", "KEYSTORE_ROOT_STALE", "ASP_ROOT_STALE"]
const CODE = /^[A-Z][A-Z_]{1,40}$/
const MAX_ADVANCE = 100_000

export interface FixtureSnapshot {
	l1: { block: number; time: string; chainId: number; account: string }
	aztec: { block: number; time: string }
	notes: { commitment: string; label: string; value: string; status: string }[]
	balances: { owner: string; label: string; origin: number; value: string }[]
	publicBalances: { owner: string; amount: string }[]
	bridges: { id: string; amount: string; label: string; state: string; l1TxHash?: string }[]
	exits: { l2TxHash: string; messageIndexInTx: number; kind: string; amount: string; settled: boolean }[]
	allowList: { sequence: string; pendingBirths: number }
	sent: { l1: number; aztec: number }
}

export interface FixtureControl {
	/** The next call of `op` fails with `code` (see `faults.ts` for what each op understands). */
	failNext(op: FixtureOp, code: string): void
	/** The next submit re-proves once for `code`'s root; a third in one submit ends it with `STALE`. */
	reproveNext(code: StaleRootCode): void
	/** The next call of `op` never settles (a `prove` until the page cancels it). */
	hangNext(op: FixtureOp): void
	/** Posts a record that approves every pending shield; after a reset, it is the next post. */
	approveBirths(): void
	/** Replaces the registry's poster: the record is cleared, at the next sequence, until the next post. */
	resetAllowList(): void
	/** Mines `blocks` Ethereum blocks (12 s each; an Aztec block every 6). */
	advance(blocks: number): void
	state(): FixtureSnapshot
	/** Selects the pool owner or the separate sender in the fixture Ethereum wallet. */
	selectL1Account(which: "owner" | "sender"): void
	setL1Chain(chainId: number): void
	/** The next connect's grant leaves out the contract scope, as the kit's `declineNextGrant`. */
	declineNextGrant(): void
	/** Clears an account's keys (the owner's by default) from the fixture keystore, as for one that never registered. */
	unregisterOwner(account?: Address): void
	/** The Aztec wallet disconnects on its own. */
	disconnectAztec(): void
	/** Back to the first state; also clears the stored copy. */
	reset(): void
}

function checkOp(op: unknown): FixtureOp {
	if (!isFixtureOp(op)) throw new Error(`__ppFixtures: unknown op ${JSON.stringify(op)}`)
	return op
}

function snapshot(w: World): FixtureSnapshot {
	const s = w.s
	const str = (n: bigint) => n.toString()
	return {
		l1: { block: s.l1Block, time: str(w.l1Time()), chainId: s.walletChain, account: selectedAccount(w) },
		aztec: { block: w.aztecBlock(), time: str(w.aztecTime()) },
		notes: s.notes.map((n) => ({ commitment: str(n.commitment), label: str(n.label), value: str(n.value), status: n.status })),
		balances: s.aztecNotes.map((n) => ({ owner: n.owner, label: str(n.label), origin: n.origin, value: str(n.value) })),
		publicBalances: s.publicBalances.map((b) => ({ owner: b.owner, amount: str(b.amount) })),
		bridges: s.bridges.map((b) => ({
			id: b.id,
			amount: str(b.amount),
			label: str(b.label),
			state: b.state,
			...(b.l1TxHash ? { l1TxHash: b.l1TxHash } : {}),
		})),
		exits: s.exits.map((e) => ({
			l2TxHash: e.l2TxHash,
			messageIndexInTx: e.messageIndexInTx,
			kind: e.kind,
			amount: str(e.amount),
			settled: e.settledTx !== undefined,
		})),
		allowList: { sequence: str(s.allowList.sequence), pendingBirths: s.allowList.pendingBirths.length },
		sent: { ...s.sent },
	}
}

export function createControl(w: World, wallet: { remoteDisconnect(): void }): FixtureControl {
	return {
		failNext(op, code) {
			if (!CODE.test(code)) throw new Error(`__ppFixtures.failNext: bad code ${JSON.stringify(code)}`)
			w.update((s) => void s.faults.fail.push({ op: checkOp(op), code }))
		},
		reproveNext(code) {
			if (!STALE_CODES.includes(code)) throw new Error(`__ppFixtures.reproveNext: bad code ${JSON.stringify(code)}`)
			w.update((s) => void s.faults.reprove.push(code))
		},
		hangNext: (op) => w.update((s) => void s.faults.hang.push(checkOp(op))),
		approveBirths: () => approveBirths(w),
		resetAllowList: () => resetAllowList(w),
		advance(blocks) {
			if (!Number.isSafeInteger(blocks) || blocks < 0 || blocks > MAX_ADVANCE)
				throw new Error("__ppFixtures.advance: blocks must be an integer from 0 to 100000")
			w.update((s) => {
				s.l1Block += blocks
			})
		},
		state: () => snapshot(w),
		selectL1Account(which) {
			if (which !== "owner" && which !== "sender") throw new Error("__ppFixtures.selectL1Account: owner or sender")
			w.update((s) => {
				s.selected = which
			})
		},
		setL1Chain(chainId) {
			if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("__ppFixtures.setL1Chain: a positive integer")
			w.update((s) => {
				s.walletChain = chainId
			})
		},
		declineNextGrant: () =>
			w.update((s) => {
				s.declineNextGrant = true
			}),
		unregisterOwner: (account = ACCOUNTS.owner) => {
			if (!isAddress(account)) throw new Error(`__ppFixtures.unregisterOwner: bad address ${JSON.stringify(account)}`)
			w.update((s) => {
				s.keystore = { ...s.keystore, [account.toLowerCase()]: { authPolicy: false, viewingKey: false } }
			})
		},
		disconnectAztec: () => wallet.remoteDisconnect(),
		reset: () => w.reset(),
	}
}
