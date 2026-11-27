import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { BridgeRecordView, PoolNoteView } from "../data/stack-types"
import { createBridgeDriver, createOutstanding } from "../data/bridge-driver"
import { bridgeReducer, initialBridge } from "../data/bridge-machine"
import type { Session } from "../data/ports"
import type { DataSource } from "../data/source"
import type { LiveStore } from "./live"

/** What the bridge view is about: a note to bridge, or a bridge read back after a reload. */
export interface BridgeSubject {
	/** The note; for a bridge read back, the spent note it came from, when the session still lists it. */
	note: PoolNoteView | null
	/** Fixed at Submit, or the read-back record's amount. */
	amount: bigint | null
}

interface Deps {
	source: DataSource
	live: LiveStore
	session: Session | null
	canClaim(): boolean
	frame(): Promise<void>
	/** After a send or a claim settles, so the reads catch up. */
	settled(): void
}

/**
 * One driver per open session, all sharing the page's outstanding wallet requests, which outlive the
 * session that issued them. `canClaim` is read at each check, so a new grant applies at once.
 */
function useDriver({ source, live, session, canClaim, frame }: Omit<Deps, "settled">) {
	const claimAllowed = useRef(canClaim)
	claimAllowed.current = canClaim
	const [outstanding] = useState(createOutstanding)
	return useMemo(
		() =>
			session
				? createBridgeDriver({
						outstanding,
						session,
						deployment: source.deployment,
						timer: source.timer,
						frame,
						context: live.context,
						canClaim: () => claimAllowed.current(),
					})
				: null,
		[outstanding, session, source, live, frame],
	)
}

/**
 * One bridge on screen at a time: the pure machine in a reducer and one driver per open session. A
 * new session, a new subject or an unmount aborts what is running; the driver's own checks decide
 * whether anything is sent.
 */
export function useBridgeFlow({ settled, ...deps }: Deps) {
	const [machine, dispatch] = useReducer(bridgeReducer, initialBridge)
	const [subject, setSubject] = useState<BridgeSubject | null>(null)
	const run = useRef(new AbortController())
	const driver = useDriver(deps)
	const fresh = useCallback(() => {
		run.current.abort()
		run.current = new AbortController()
		dispatch({ type: "reset" })
		return run.current.signal
	}, [])

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new driver means a new session, which ends the flow.
	useEffect(() => {
		fresh()
		setSubject(null)
		return () => run.current.abort()
	}, [driver, fresh])

	const open = useCallback(
		(note: PoolNoteView) => {
			fresh()
			setSubject({ note, amount: null })
		},
		[fresh],
	)

	const resume = useCallback(
		(record: BridgeRecordView, note: PoolNoteView | null) => {
			const signal = fresh()
			dispatch({ type: "record", record })
			setSubject({ note, amount: record.amount })
			void driver?.follow(record, dispatch, signal)
		},
		[driver, fresh],
	)

	const send = useCallback(
		async (note: PoolNoteView, amount: bigint, recipient: string, acceptUncertain: boolean, signal: AbortSignal) => {
			if (!driver) return
			const record = await driver.submit(
				{ note, amount, recipient },
				dispatch,
				signal,
				acceptUncertain ? { acceptUncertain: true } : {},
			)
			settled()
			if (record && !signal.aborted) await driver.follow(record, dispatch, signal)
		},
		[driver, settled],
	)

	const submit = useCallback(
		async (amount: bigint, recipient: string, acceptUncertain = false) => {
			const note = subject?.note
			if (!note) return
			setSubject({ note, amount })
			await send(note, amount, recipient, acceptUncertain, run.current.signal)
		},
		[subject, send],
	)

	/** Checks a bridge the page could not confirm (no override) or sends it again (`acceptUncertain`). */
	const retry = useCallback(
		async (note: PoolNoteView, record: BridgeRecordView, acceptUncertain: boolean) => {
			const signal = fresh()
			setSubject({ note, amount: record.amount })
			await send(note, record.amount, record.recipient, acceptUncertain, signal)
		},
		[fresh, send],
	)

	const claim = useCallback(async () => {
		if (!driver || !machine.record) return
		await driver.claim(machine.record, dispatch, run.current.signal)
		settled()
	}, [driver, machine.record, settled])

	return {
		machine,
		subject,
		open,
		resume,
		submit,
		retry,
		claim,
		preflight: useCallback((recipient: string) => void driver?.preflight(recipient, dispatch, run.current.signal), [driver]),
		invalidate: useCallback(() => dispatch({ type: "invalidate" }), []),
		/** Back to a fresh form for the same note. */
		restart: useCallback(() => void fresh(), [fresh]),
		close: useCallback(() => {
			fresh()
			setSubject(null)
		}, [fresh]),
		hold: useCallback((notes: ReadonlySet<bigint>) => driver?.hold(notes), [driver]),
		submitting: useCallback((): ReadonlySet<bigint> => driver?.submitting() ?? new Set(), [driver]),
	}
}

export type BridgeFlow = ReturnType<typeof useBridgeFlow>
