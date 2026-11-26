// Compile-time only: the hand-written public entries in types/ must equal the implementation, export
// for export, so dependents that typecheck against them see what runs.
import type { NoteStatus } from "#ppv2/evm-sdk"
import type * as ClientImpl from "../../src/client/index.ts"
import type { NoteStatusName } from "../../src/client/types.ts"
import type * as Impl from "../../src/index.ts"
import type * as ClientPublic from "../../types/client.js"
import type * as Public from "../../types/index.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
/** Names of exports that differ: missing on either side, or declared with a different type. */
type Mismatched<I, P> =
	| Exclude<keyof I, keyof P>
	| Exclude<keyof P, keyof I>
	| { [K in keyof I & keyof P]: Equal<I[K], P[K]> extends true ? never : K }[keyof I & keyof P]

export type Conformance = [
	Assert<Equal<Mismatched<typeof Impl, typeof Public>, never>>,
	Assert<Equal<Mismatched<typeof ClientImpl, typeof ClientPublic>, never>>,
	Assert<Equal<NoteStatusName, `${NoteStatus}`>>,
]
