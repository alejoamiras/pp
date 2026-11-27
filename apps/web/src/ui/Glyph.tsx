type Cell = readonly [x: number, y: number]

/**
 * The lit cells of a 5×5 mark mirrored about its middle column, from 15 bits of FNV-1a over the
 * seed: one seed, one mark. An all-dark hash still draws the centre cell.
 */
export function glyphCells(seed: string): Cell[] {
	let h = 2166136261
	for (const c of seed) {
		h ^= c.charCodeAt(0)
		h = Math.imul(h, 16777619) >>> 0
	}
	const cells: Cell[] = []
	for (let y = 0; y < 5; y++) {
		for (let x = 0; x < 3; x++) {
			if (((h >>> (y * 3 + x)) & 1) === 0) continue
			cells.push([x, y])
			if (x < 2) cells.push([4 - x, y])
		}
	}
	return cells.length > 0 ? cells : [[2, 2]]
}

export function Glyph({ seed, size = 14 }: { seed: string; size?: number }) {
	return (
		<svg viewBox="0 0 20 20" width={size} height={size} fill="currentColor" aria-hidden="true" data-glyph="">
			{glyphCells(seed).map(([x, y]) => (
				<rect key={`${x}.${y}`} x={x * 4} y={y * 4} width="4" height="4" />
			))}
		</svg>
	)
}
