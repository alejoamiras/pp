/** The messages between the page and its allow-list worker; values cross as structured clones, bigints included. */
import type { LabelCheck, Origin, RootRecord } from "@pp/label-paths"

/** What a record commits its two lists to: a root does not fix its list's length, so both lengths too. */
export type Lists = Pick<RootRecord, "poolRoot" | "birthRoot" | "poolSize" | "birthSize">

/** `key` names the lists the page fetched `text` for. */
export type JobRequest =
	| { kind: "load"; key: string; text: string; lists: Lists }
	| { kind: "check"; key: string; record: RootRecord; label: bigint; origin: Origin; nowSec: bigint }

/** `NOT_LOADED`: the worker holds no list for the check's key. */
export type ListFailure = "MISMATCH" | "OVERSIZED" | "NOT_LOADED"

export type JobReply =
	| { kind: "loaded" }
	| { kind: "progress"; hashed: number; total: number }
	| { kind: "checked"; result: LabelCheck }
	| { kind: "failed"; failure: ListFailure }

export const listsKey = (r: Lists): string => [r.poolRoot, r.birthRoot, r.poolSize, r.birthSize].map((v) => v.toString(16)).join(":")
