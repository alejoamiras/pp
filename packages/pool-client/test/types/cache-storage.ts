// Compile-time only, under tsconfig.json's DOM lib: the browser's Cache Storage must satisfy the slice
// cache-store.ts types for itself, so that local type cannot drift from what the page calls.
import type { CacheStorageLike } from "../../src/runtime/cache-store.ts"

type Assert<T extends true> = T

export type CacheStorageFits = Assert<CacheStorage extends CacheStorageLike ? true : false>
