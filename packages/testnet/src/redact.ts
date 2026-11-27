/**
 * Every key value this process loaded, so text bound for stdout or stderr can be scrubbed of them. The
 * CLIs never format a value; this catches a library error that echoes one.
 */
const loaded = new Set<string>()

/** Registers values; each is matched with or without `0x`, in any letter case. */
export function remember(values: Iterable<string>): void {
	for (const v of values) {
		const bare = v.toLowerCase().replace(/^0x/, "")
		if (bare.length > 0) loaded.add(bare)
	}
}

/** `text` with every loaded value, prefixed or bare, replaced by `[redacted]`. */
export function redact(text: string): string {
	let out = text
	for (const bare of loaded) out = out.replace(new RegExp(`(0x)?${bare}`, "gi"), "[redacted]")
	return out
}
