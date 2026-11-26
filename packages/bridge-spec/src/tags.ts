/**
 * The v1 tags as 32-byte words: each ASCII string read as a big-endian integer (< 2^248, so also a
 * field). Normative as hex: a right-padded `bytes32("…")` would exceed the field and never match Noir.
 */
export const TAGS = {
	DATA_V1: "0x00000000000000000000000000000070702e6272696467652e646174612e7631",
	IN_V1: "0x000000000000000000000000000000000070702e6272696467652e696e2e7631",
	OUT_V1: "0x0000000000000000000000000000000070702e6272696467652e6f75742e7631",
	RAGEQUIT_V1: "0x000000000000000000000070702e6272696467652e72616765717569742e7631",
} as const

export const TAG_STRINGS = {
	DATA_V1: "pp.bridge.data.v1",
	IN_V1: "pp.bridge.in.v1",
	OUT_V1: "pp.bridge.out.v1",
	RAGEQUIT_V1: "pp.bridge.ragequit.v1",
} as const

/** ASCII of at most 31 bytes as a big-endian integer. */
export function tagWord(ascii: string): bigint {
	if (!/^[\x20-\x7e]{1,31}$/.test(ascii)) throw new Error(`a tag is 1 to 31 printable ASCII bytes: ${ascii}`)
	let v = 0n
	for (const c of ascii) v = (v << 8n) | BigInt(c.charCodeAt(0))
	return v
}

export const tagValue = (tag: keyof typeof TAGS): bigint => BigInt(TAGS[tag])
