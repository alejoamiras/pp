import { useCallback, useRef, useState } from "react"
import type { AztecAddress } from "../data/stack-types"
import type { UiCode } from "../data/errors"
import type { Sent } from "../data/ports"
import type { DataSource } from "../data/source"
import { isFinal, MAKES_CHANGE, sentOutcome, type TxAction, type TxOutcome, thrownOutcome } from "../data/tx"
import { useAztecNow } from "./queries"

/**
 * One Aztec send at a time from this page, so a first send to a new recipient always goes alone; and
 * after an unshield reverts, no change-making spend until that revert is final in chain time.
 */
export function useTx(source: DataSource, refresh: () => void) {
	const busy = useRef(false)
	const [pending, setPending] = useState<TxAction | null>(null)
	const [revertSeenAt, setRevertSeenAt] = useState<bigint | null>(null)
	const [known, setKnown] = useState<ReadonlySet<AztecAddress>>(() => new Set())
	const now = useAztecNow(source).data
	const waitingFinality = revertSeenAt !== null && (now === undefined || !isFinal(revertSeenAt, now))

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
				const outcome = sentOutcome(action, await send())
				if (!outcome.ok && outcome.code === "UNSHIELD_REVERTED") setRevertSeenAt(await source.clock.aztecNow())
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
		[source, refresh, waitingFinality],
	)

	return { run, blocked, pending, isNewRecipient: (r: AztecAddress) => !known.has(r) }
}

export type Tx = ReturnType<typeof useTx>
