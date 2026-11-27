import { useCallback, useRef, useState } from "react"
import type { AztecAddress } from "../data/stack-types"
import type { UiCode } from "../data/errors"
import type { Sent } from "../data/ports"
import type { DataSource } from "../data/source"
import { isFinal, MAKES_CHANGE, sentOutcome, type TxAction, type TxOutcome, thrownOutcome } from "../data/tx"
import { useAztecProven } from "./queries"

/**
 * One Aztec send at a time from this page, so a first send to a new recipient always goes alone; and
 * after an unshield reverts, no change-making spend until the node's proven block reaches the block it
 * reverted in. A failed read of the proven block keeps the wait.
 */
export function useTx(source: DataSource, refresh: () => void) {
	const busy = useRef(false)
	const [pending, setPending] = useState<TxAction | null>(null)
	const [revertBlock, setRevertBlock] = useState<number | null>(null)
	const [known, setKnown] = useState<ReadonlySet<AztecAddress>>(() => new Set())
	const proven = useAztecProven(source, revertBlock !== null).data
	const waitingFinality = revertBlock !== null && !isFinal(revertBlock, proven)

	const blocked = useCallback(
		(action: TxAction): UiCode | null => {
			if (pending !== null) return "TX_BUSY"
			return MAKES_CHANGE.has(action) && waitingFinality ? "WAIT_FINALITY" : null
		},
		[pending, waitingFinality],
	)

	const run = useCallback(
		async (action: TxAction, send: () => Promise<Sent>, recipient?: AztecAddress): Promise<TxOutcome> => {
			if (busy.current) return { ok: false, code: "TX_BUSY" }
			if (MAKES_CHANGE.has(action) && waitingFinality) return { ok: false, code: "WAIT_FINALITY" }
			busy.current = true
			setPending(action)
			try {
				const sent = await send()
				const outcome = sentOutcome(action, sent)
				if (!outcome.ok && outcome.code === "UNSHIELD_REVERTED" && sent.status === "reverted") {
					const { block } = sent
					setRevertBlock((b) => Math.max(b ?? 0, block))
				}
				if (outcome.ok && recipient) setKnown((k) => new Set(k).add(recipient))
				return outcome
			} catch (err) {
				return thrownOutcome(err)
			} finally {
				busy.current = false
				setPending(null)
				refresh()
			}
		},
		[refresh, waitingFinality],
	)

	return { run, blocked, pending, isNewRecipient: (r: AztecAddress) => !known.has(r) }
}

export type Tx = ReturnType<typeof useTx>
