// Browser-safe: nothing here may import an Aztec package, viem or a `node:` module (a test scans every specifier).
export type { LabelCheck, LabelPathCacheOptions } from "./cache"
export { LabelPathCache } from "./cache"
export { parseAspSnapshot, parseAspSnapshotUnverified, serializeAspSnapshot } from "./codec"
export type { Hex } from "./record"
export { RegistryAddressError, ROOT_RECORD_SLOT, readRootRecord, SIZES_SLOT } from "./record"
export type { AspSnapshot, LabelState, Origin, RootRecord, SnapshotErrorCode } from "./snapshot"
export {
	labelState,
	MAX_LEAVES,
	MAX_OBSERVATION_LAG,
	MAX_ROOT_AGE,
	pathFor,
	rootFresh,
	SnapshotError,
	SPEND_WINDOW,
	verifySnapshot,
} from "./snapshot"
export type { LabelPath } from "@pp/bridge-spec"
