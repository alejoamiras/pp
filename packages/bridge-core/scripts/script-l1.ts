/** L1-side helpers shared by the generation deploy: the read-back assertion it runs on every address. */

export const lc = (v: unknown) => String(v).toLowerCase()

/** Case-insensitive read-back assert: abort the run on any mismatch, log the ✓ otherwise. */
export function assertSame(actual: unknown, expected: unknown, label: string): void {
	if (lc(actual) !== lc(expected)) throw new Error(`read-back FAILED: ${label} - on-chain ${lc(actual)} != expected ${lc(expected)}`)
	console.log(`  ✓ ${label}`)
}
