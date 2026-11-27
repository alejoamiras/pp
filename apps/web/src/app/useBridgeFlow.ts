import { type RefObject, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { BridgeRecordView, PoolNoteView } from "../data/stack-types"
import { type BridgeDriver, createBridgeDriver, createOutstanding, type Dispatch } from "../data/bridge-driver"
import { bridgeReducer, initialBridge, offerFor } from "../data/bridge-machine"
import type { Session } from "../data/ports"
import type { DataSource } from "../data/source"
import type { LiveStore } from "./live"

/** What the bridge view is about: a note to bridge, or a bridge read back after a reload. */
export interface BridgeSubject {
	/** The note; for a bridge read back, the spent note it came from, when the session still lists it. */
	note: PoolNoteView | null
	/** Fixed at Submit, or the read-back record's amount. */
	amount: bigint | null
	/** Fixed at Submit, or the read-back record's; a resend keeps it, as the journal's intent must match. */
	recipient: string | null
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

interface CheckDeps {
	driver: BridgeDriver | null
	dispatch: Dispatch
	settled(): void
	fresh(): AbortSignal
	run: RefObject<AbortController>
	subject: BridgeSubject | null
	setSubject(s: BridgeSubject): void
}

/** Check again, which reads the journal and the chain and never proves or sends. */
function useCheck({ driver, dispatch, settled, fresh, run, subject, setSubject }: CheckDeps) {
	const look = useCallback(
		async (note: PoolNoteView, recipient: string, signal: AbortSignal) => {
			if (!driver) return
			const record = await driver.check({ note, recipient }, dispatch, signal)
			settled()
			if (record && !signal.aborted) await driver.follow(record, dispatch, signal)
		},
		[driver, dispatch, settled],
	)
	return {
		/** On the bridge on screen. */
		check: useCallback(async () => {
			if (subject?.note && subject.recipient !== null) await look(subject.note, subject.recipient, run.current.signal)
		}, [subject, look, run]),
		/** On a note the pool shows unconfirmed: opens it as the pool showed it, then reads. */
		recheck: useCallback(
			async (note: PoolNoteView, record: BridgeRecordView) => {
				const signal = fresh()
				setSubject({ note, amount: record.amount, recipient: record.recipient })
				dispatch({ type: "failed", failure: { code: "UNCERTAIN", during: "preparing", offer: offerFor("UNCERTAIN") } })
				await look(note, record.recipient, signal)
			},
			[fresh, setSubject, dispatch, look],
		),
	}
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
			setSubject({ note, amount: null, recipient: null })
		},
		[fresh],
	)

	const resume = useCallback(
		(record: BridgeRecordView, note: PoolNoteView | null) => {
			const signal = fresh()
			dispatch({ type: "record", record })
			setSubject({ note, amount: record.amount, recipient: record.recipient })
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
			setSubject({ note, amount, recipient })
			await send(note, amount, recipient, acceptUncertain, run.current.signal)
		},
		[subject, send],
	)

	/** Sends a bridge the page could not confirm again, with `acceptUncertain`. */
	const retry = useCallback(
		async (note: PoolNoteView, record: BridgeRecordView) => {
			const signal = fresh()
			setSubject({ note, amount: record.amount, recipient: record.recipient })
			await send(note, record.amount, record.recipient, true, signal)
		},
		[fresh, send],
	)

	const { check, recheck } = useCheck({ driver, dispatch, settled, fresh, run, subject, setSubject })

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
		check,
		recheck,
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
