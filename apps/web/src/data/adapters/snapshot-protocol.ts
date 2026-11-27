/** The messages between the page and its allow-list worker; values cross as structured clones, bigints included. */
import type { LabelCheck, Origin, RootRecord } from "@pp/label-paths"

export interface Roots {
	poolRoot: bigint
	birthRoot: bigint
}

/** `key` names the pair of roots the page fetched `text` for. */
export type JobRequest =
	| { kind: "load"; key: string; text: string; roots: Roots }
	| { kind: "check"; key: string; record: RootRecord; label: bigint; origin: Origin; nowSec: bigint }

/** `NOT_LOADED`: the worker holds no list for the check's key. */
export type ListFailure = "MISMATCH" | "OVERSIZED" | "NOT_LOADED"

export type JobReply =
	| { kind: "loaded" }
	| { kind: "progress"; hashed: number; total: number }
	| { kind: "checked"; result: LabelCheck }
	| { kind: "failed"; failure: ListFailure }

export const rootsKey = (r: Roots): string => `${r.poolRoot.toString(16)}:${r.birthRoot.toString(16)}`
