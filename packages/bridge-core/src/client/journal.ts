import type { Hash } from "viem"
import { z } from "zod"

/** The app passes `localStorage`; tests pass a map. No enumeration: records are found by nullifier. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** One send handed to the wallet; `l1TxHash` is absent until the wallet returns it. */
export type JournalAttempt = { l1TxHash?: Hash }

/**
 * What the chain cannot show yet about one bridge of one note. Exactly these fields: no salt,
 * opening, label, commitment, key or status ever enters a record.
 */
export type JournalRecord = {
	nullifier: bigint
	recipient: string
	amount: bigint
	attempts: JournalAttempt[]
	/** An unresolved attempt was dropped to admit a new one; its hash may still land. Never cleared. */
	evicted?: true
}

export type JournalKeys = { seal: CryptoKey; id: CryptoKey }

export const STORAGE_PREFIX = "pp.bridge.j1."
const SEAL_INFO = "pp.bridge/journal-seal/v1"
const ID_INFO = "pp.bridge/journal-id/v1"
const IV_BYTES = 12

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/)
const hash = z.string().regex(/^0x[0-9a-f]{64}$/)
const plaintext = z.strictObject({
	v: z.literal(1),
	nullifier: decimal,
	recipient: hash,
	amount: decimal,
	attempts: z.array(z.strictObject({ l1TxHash: hash.optional() })),
	evicted: z.literal(true).optional(),
})
const sealed = z.strictObject({ v: z.literal(1), iv: z.base64(), ct: z.base64() })

const utf8 = (s: string) => new TextEncoder().encode(s)

function toBase64(bytes: Uint8Array, url = false): string {
	let bin = ""
	for (const b of bytes) bin += String.fromCharCode(b)
	const b64 = btoa(bin)
	return url ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

function be32(n: bigint): Uint8Array {
	if (n < 0n || n >= 1n << 256n) throw new RangeError("nullifier out of range")
	const out = new Uint8Array(32)
	for (let i = 31, v = n; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn)
	return out
}

/**
 * Two independent non-extractable keys from the claim key, separated by HKDF label: one seals
 * records, one names them. Neither can be exported, so nothing outside WebCrypto ever holds them.
 */
export async function deriveJournalKeys(claimKey: Uint8Array): Promise<JournalKeys> {
	const base = await crypto.subtle.importKey("raw", new Uint8Array(claimKey), "HKDF", false, ["deriveKey"])
	const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) })
	const seal = await crypto.subtle.deriveKey(hkdf(SEAL_INFO), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
	const id = await crypto.subtle.deriveKey(hkdf(ID_INFO), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"])
	return { seal, id }
}

/** The opaque id of one note's record: HMAC output only, so the key reveals no field. */
export async function recordId(keys: JournalKeys, deploymentId: string, nullifier: bigint): Promise<string> {
	const message = new Uint8Array([...utf8(deploymentId), 0, ...be32(nullifier)])
	return toBase64(new Uint8Array(await crypto.subtle.sign("HMAC", keys.id, message)), true)
}

function encode(r: JournalRecord): string {
	return JSON.stringify({
		v: 1,
		nullifier: r.nullifier.toString(),
		recipient: r.recipient.toLowerCase(),
		amount: r.amount.toString(),
		attempts: r.attempts.map((a) => (a.l1TxHash === undefined ? {} : { l1TxHash: a.l1TxHash.toLowerCase() })),
		...(r.evicted ? { evicted: true } : {}),
	})
}

function decode(json: string): JournalRecord | null {
	let value: unknown
	try {
		value = JSON.parse(json)
	} catch {
		return null
	}
	const p = plaintext.safeParse(value)
	if (!p.success) return null
	return {
		nullifier: BigInt(p.data.nullifier),
		recipient: p.data.recipient,
		amount: BigInt(p.data.amount),
		attempts: p.data.attempts.map((a) => (a.l1TxHash === undefined ? {} : { l1TxHash: a.l1TxHash as Hash })),
		...(p.data.evicted ? { evicted: true as const } : {}),
	}
}

/** AES-GCM under a fresh nonce, with the storage key as associated data: a value moved to another key fails to open. */
export async function sealRecord(keys: JournalKeys, storageKey: string, r: JournalRecord): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(storageKey) }, keys.seal, utf8(encode(r)))
	return JSON.stringify({ v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) })
}

/** `null` for anything that does not open under this key at this storage key, or holds any other field. */
export async function openRecord(keys: JournalKeys, storageKey: string, value: string): Promise<JournalRecord | null> {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	const s = sealed.safeParse(parsed)
	if (!s.success) return null
	const iv = fromBase64(s.data.iv)
	if (iv.length !== IV_BYTES) return null
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(storageKey) }, keys.seal, fromBase64(s.data.ct))
		return decode(new TextDecoder().decode(pt))
	} catch {
		return null
	}
}

/** One owner's records in one deployment. */
export class Journal {
	readonly #store: KeyValueStore
	readonly #keys: JournalKeys
	readonly #deploymentId: string

	constructor(store: KeyValueStore, keys: JournalKeys, deploymentId: string) {
		this.#store = store
		this.#keys = keys
		this.#deploymentId = deploymentId
	}

	id(nullifier: bigint): Promise<string> {
		return recordId(this.#keys, this.#deploymentId, nullifier)
	}

	async #storageKey(nullifier: bigint): Promise<string> {
		return STORAGE_PREFIX + (await this.id(nullifier))
	}

	/** The raw stored value (for an exact restore) and the record it opens to, if any. */
	async read(nullifier: bigint): Promise<{ raw: string | null; record: JournalRecord | null }> {
		const key = await this.#storageKey(nullifier)
		const raw = this.#store.getItem(key)
		if (raw === null) return { raw, record: null }
		const record = await openRecord(this.#keys, key, raw)
		return { raw, record: record?.nullifier === nullifier ? record : null }
	}

	/** @returns the stored value, which `restore` uses to tell its own write from a later one */
	async write(r: JournalRecord): Promise<string> {
		const key = await this.#storageKey(r.nullifier)
		const sealed = await sealRecord(this.#keys, key, r)
		this.#store.setItem(key, sealed)
		return sealed
	}

	/**
	 * Puts back what `read` returned, so a rejected attempt leaves no trace, but only while the stored
	 * value is still `written`: a record another writer saved since then is kept.
	 */
	async restore(nullifier: bigint, raw: string | null, written: string): Promise<void> {
		const key = await this.#storageKey(nullifier)
		if (this.#store.getItem(key) !== written) return
		if (raw === null) this.#store.removeItem(key)
		else this.#store.setItem(key, raw)
	}

	async remove(nullifier: bigint): Promise<void> {
		this.#store.removeItem(await this.#storageKey(nullifier))
	}
}
