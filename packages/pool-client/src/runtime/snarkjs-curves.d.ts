// snarkjs ships no types. A module declaration here, not an ambient `declare module "snarkjs"`, so a
// consumer compiling these sources keeps its own snarkjs types.
export declare const curves: {
	getCurveFromName(name: string, opts: { singleThread: boolean }): Promise<unknown>
}
