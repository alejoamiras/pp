/**
 * Reads a `start`-paged token view to the end: `private_balances_by_label` returns up to 16 entries
 * and `private_notes_by_label` up to 10, from index `start`. A short page is the last one. The page
 * count is bounded, since the answer is contract- and wallet-controlled.
 */
export const BALANCES_PAGE = 16
export const NOTES_PAGE = 10
const MAX_PAGES = 64

export async function readAllPages<T>(page: (start: number) => Promise<readonly T[]>, size: number): Promise<T[]> {
	const out: T[] = []
	for (let i = 0; i < MAX_PAGES; i++) {
		const items = await page(out.length)
		out.push(...items.slice(0, size))
		if (items.length < size) return out
	}
	return out
}
