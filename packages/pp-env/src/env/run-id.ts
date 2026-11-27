/** A run id names port rows and directories, so it stays one safe path segment. */
export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `RUN_ID.test` alone coerces its argument, so an untyped caller's `undefined` would pass as "undefined". */
export const isRunId = (value: unknown): value is string => typeof value === "string" && RUN_ID.test(value)
