/**
 * The packages' public types the app reads, re-exported type-only from `@pp/bridge-core`,
 * `@pp/pool-client` and `@pp/label-paths`, so a change upstream fails to compile here. Nothing here
 * has a runtime value.
 *
 * One deliberate difference: `AztecAddress` is a branded canonical hex string, not aztec.js's class.
 * Importing that class at runtime pulls bb.js and its wasm (about 11 MB) into every bundle, so the
 * screens and the fixture world carry the string, and the stack adapters convert at their boundary
 * with `parseAztecAddress`, which reads either form. The shapes that carry an Aztec address are
 * re-declared over the package's own type with only that field swapped.
 */
import type { BridgeRecordView as CoreBridgeRecordView, ExitTicket as CoreExitTicket, ragequitChunks } from "@pp/bridge-core"
import type { Hex } from "viem"

export type {
	BridgeClientError,
	BridgeClientErrorCode,
	BridgeReceipt,
	BridgeSession,
	BridgeStep,
	ExitStatus,
	SpendCheckName,
	StackManifest,
	StaleRootCode,
} from "@pp/bridge-core"
export type { AspSnapshot, LabelCheck, LabelPath, LabelState, Origin, RootRecord } from "@pp/label-paths"
export type { NoteStatus as PoolNoteStatus, PoolNoteView } from "@pp/pool-client"

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** 0x + 64 lower-case hex digits, below the BN254 scalar modulus. Curve validity is not implied. */
export type AztecAddress = Brand<Hex, "AztecAddress">

/** `id` equals `recover`'s id for the same nullifier; a reverted send reads `{ error: "REVERTED" }`. */
export type BridgeRecordView = Omit<CoreBridgeRecordView, "recipient"> & { recipient: AztecAddress }

/** Distributes over the ticket kinds, so each keeps its own fields. */
type WithAztecToken<T> = T extends unknown ? Omit<T, "token"> & { token: AztecAddress } : never
export type ExitTicket = WithAztecToken<CoreExitTicket>

/** Exact chunks only: each a descending prefix of at most 8 whole notes; otherwise `NO_EXACT_CHUNKS`. */
export type RagequitChunks = typeof ragequitChunks
