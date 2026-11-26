declare module "snarkjs" {
	export const curves: { getCurveFromName(name: string, opts: { singleThread: boolean }): Promise<unknown> }
}
