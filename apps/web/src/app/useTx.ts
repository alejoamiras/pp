import { useCallback, useRef, useState } from "react"
import type { Hex } from "viem"
import type { AztecAddress } from "../data/stack-types"
import { isWalletRefusal, type UiCode } from "../data/errors"
import type { Sent } from "../data/ports"
import type { DataSource } from "../data/source"
import { beforeHandoffOutcome, isFinal, MAKES_CHANGE, REVERT_WAITS_FINALITY, sentOutcome, type TxAction, type TxOutcome } from "../data/tx"
import { useAztecProven } from "./queries"

/** A send from one account that may still land: `txHash` is what a Refresh reads, absent when the wallet's send threw. */
type Unsettled = { action: TxAction; txHash?: Hex }

/** Whether `sent` may still land on Aztec, and so must hold its account. */
const mayLand = (sent: Sent): boolean => sent.status === "unconfirmed" || sent.status === "dropped"

const heldCode = (u: Unsettled | undefined): UiCode | null => (u ? (u.txHash ? "TX_UNSETTLED" : "TX_UNSETTLED_NO_HASH") : null)

/**
 * One Aztec send at a time from this page, so a first send to a new recipient always goes alone; and
 * after an unshield reverts, no change-making spend until the node's proven block reaches the block it
 * reverted in. A failed read of the proven block keeps the wait.
 *
 * A send that may still land holds its account: no send from it until a Refresh the user makes reads
 * that transaction included or reverted. A pending receipt or a failed read keeps the hold, and one
 * with no hash holds until the page reloads. Held in memory only, and never released by a timer.
 */
export function useTx(source: DataSource, refresh: () => void) {
	const busy = useRef(false)
	const [pending, setPending] = useState<TxAction | null>(null)
	const [revertBlock, setRevertBlock] = useState<number | null>(null)
	const [known, setKnown] = useState<ReadonlySet<AztecAddress>>(() => new Set())
	const held = useRef(new Map<AztecAddress, Unsettled>())
	const [holds, setHolds] = useState<ReadonlyMap<AztecAddress, Unsettled>>(() => new Map())
	const proven = useAztecProven(source, revertBlock !== null).data
	const waitingFinality = revertBlock !== null && !isFinal(revertBlock, proven)

	const hold = useCallback((from: AztecAddress, u: Unsettled | null) => {
		if (u === null) held.current.delete(from)
		else held.current.set(from, u)
		setHolds(new Map(held.current))
	}, [])

	const reverted = useCallback((action: TxAction, block: number) => {
		if (REVERT_WAITS_FINALITY.has(action)) setRevertBlock((b) => Math.max(b ?? 0, block))
	}, [])

	const closed = useCallback(
		(action: TxAction, u: Unsettled | undefined): UiCode | null =>
			heldCode(u) ?? (MAKES_CHANGE.has(action) && waitingFinality ? "WAIT_FINALITY" : null),
		[waitingFinality],
	)

	const blocked = useCallback(
		(action: TxAction, from: AztecAddress | null): UiCode | null =>
			pending !== null ? "TX_BUSY" : closed(action, from === null ? undefined : holds.get(from)),
		[pending, holds, closed],
	)

	const answered = useCallback(
		(action: TxAction, from: AztecAddress, sent: Sent, recipient: AztecAddress | undefined): TxOutcome => {
			if (mayLand(sent)) hold(from, { action, ...(sent.txHash ? { txHash: sent.txHash } : {}) })
			const outcome = sentOutcome(action, sent)
			if (!outcome.ok && sent.status === "reverted") reverted(action, sent.block)
			if (outcome.ok && recipient) setKnown((k) => new Set(k).add(recipient))
			return outcome
		},
		[hold, reverted],
	)

	/** `send` calls `handedOff` once the wallet holds the request. */
	const run = useCallback(
		async (
			action: TxAction,
			from: AztecAddress,
			send: (handedOff: () => void) => Promise<Sent>,
			recipient?: AztecAddress,
		): Promise<TxOutcome> => {
			const refused = busy.current ? "TX_BUSY" : closed(action, held.current.get(from))
			if (refused !== null) return { ok: false, code: refused }
			busy.current = true
			setPending(action)
			let handed = false
			try {
				const sent = await send(() => {
					handed = true
				})
				return answered(action, from, sent, recipient)
			} catch (err) {
				if (!handed) return beforeHandoffOutcome(err)
				// Past the handoff, only a trusted refusal shape is a no; anything else may hide a send that went out.
				if (isWalletRefusal(err)) return { ok: false, code: "WALLET_REJECTED" }
				hold(from, { action })
				return { ok: false, code: "UNKNOWN" }
			} finally {
				busy.current = false
				setPending(null)
				refresh()
			}
		},
		[refresh, closed, answered, hold],
	)

	/** For the user's Refresh only: reads each held send's receipt and releases those included or reverted. */
	const check = useCallback(async () => {
		await Promise.all(
			[...held.current].map(async ([from, u]) => {
				if (!u.txHash) return
				const r = await source.receipts.aztec(u.txHash).catch(() => null)
				if (r === null || r.status === "pending" || held.current.get(from) !== u) return
				if (r.status === "reverted") reverted(u.action, r.block)
				hold(from, null)
			}),
		)
	}, [source, hold, reverted])

	return { run, blocked, check, pending, isNewRecipient: (r: AztecAddress) => !known.has(r) }
}

export type Tx = ReturnType<typeof useTx>
