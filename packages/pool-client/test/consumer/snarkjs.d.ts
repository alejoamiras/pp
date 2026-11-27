// A consumer's own snarkjs types, in DefinitelyTyped's shape; tsconfig.entries.json maps `snarkjs` here.
export declare const groth16: {
	fullProve(input: object, wasm: string, zkey: string): Promise<{ proof: object; publicSignals: string[] }>
}
