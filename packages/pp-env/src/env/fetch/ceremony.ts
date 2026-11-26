/** Parses CEREMONY.md's "| `circuit` | `sha256` |" rows into circuit → zkey sha256. */
export function parseCeremonyTable(markdown: string): Map<string, string> {
	const rows = new Map<string, string>()
	for (const m of markdown.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/gm)) {
		const [, circuit, sha] = m
		if (!circuit || !sha) continue
		if (rows.has(circuit)) throw new Error(`CEREMONY.md lists ${circuit} twice`)
		rows.set(circuit, sha)
	}
	return rows
}
