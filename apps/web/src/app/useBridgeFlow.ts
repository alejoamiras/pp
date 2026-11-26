import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { BridgeRecordView, PoolNoteView } from "../data/a7"
import { createBridgeDriver } from "../data/bridge-driver"
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
 * One bridge on screen at a time: the pure machine in a reducer and one driver per open session. A
 * new session, a new subject or an unmount aborts what is running; the driver's own checks decide
 * whether anything is sent.
 */
export function useBridgeFlow({ source, live, session, canClaim, frame, settled }: Deps) {
	const [machine, dispatch] = useReducer(bridgeReducer, initialBridge)
	const [subject, setSubject] = useState<BridgeSubject | null>(null)
	const claimAllowed = useRef(canClaim)
	claimAllowed.current = canClaim
	const run = useRef(new AbortController())
	const driver = useMemo(
		() =>
			session
				? createBridgeDriver({
						session,
						deployment: source.deployment,
						timer: source.timer,
						frame,
						context: live.context,
						canClaim: () => claimAllowed.current(),
					})
				: null,
		[session, source, live, frame],
	)
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

	const submit = useCallback(
		async (amount: bigint, recipient: string, acceptUncertain = false) => {
			const note = subject?.note
			if (!driver || !note) return
			const signal = run.current.signal
			setSubject({ note, amount })
			const record = await driver.submit(
				{ note, amount, recipient },
				dispatch,
				signal,
				acceptUncertain ? { acceptUncertain: true } : {},
			)
			settled()
			if (record && !signal.aborted) await driver.follow(record, dispatch, signal)
		},
		[driver, subject, settled],
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
		claim,
		preflight: useCallback((recipient: string) => void driver?.preflight(recipient, dispatch, run.current.signal), [driver]),
		invalidate: useCallback(() => dispatch({ type: "invalidate" }), []),
		/** Back to a fresh form for the same note. */
		restart: useCallback(() => void fresh(), [fresh]),
		close: useCallback(() => {
			fresh()
			setSubject(null)
		}, [fresh]),
		hold: useCallback((note: bigint) => driver?.hold(note, "IN_FLIGHT"), [driver]),
	}
}

export type BridgeFlow = ReturnType<typeof useBridgeFlow>
