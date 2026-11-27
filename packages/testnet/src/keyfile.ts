/**
 * The one key file, `~/.config/pp/testnet.env`: `NAME=value` lines, written by `keys` and read only here.
 * No value ever reaches an error: a refusal names the file, a line number or a variable, never content.
 */
import { randomBytes } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, type Stats, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isHex } from "viem"
import { GuardError } from "./errors"

/** A key's role decides how it is checked; L2 secrets are field elements, L1 keys secp256k1 private keys. */
export type KeySpec = { name: string; kind: "l1" | "l2" }

/** Every name the file holds; `testnet.env.example` lists exactly these. */
export const KEY_NAMES = [
	{ name: "L1_DEPLOYER_KEY", kind: "l1" },
	{ name: "POOL_DEPLOYER_KEY", kind: "l1" },
	{ name: "ASP_POSTMAN_KEY", kind: "l1" },
	{ name: "GUARDIAN_KEY", kind: "l1" },
	{ name: "CANARY_OWNER_KEY", kind: "l1" },
	{ name: "CANARY_SENDER_KEY", kind: "l1" },
	{ name: "L2_DEPLOYER_SECRET", kind: "l2" },
	{ name: "BOT_POSTER_SECRET", kind: "l2" },
	{ name: "BOT_INTAKE_SECRET", kind: "l2" },
] as const satisfies readonly KeySpec[]

export type KeyName = (typeof KEY_NAMES)[number]["name"]

/** `<home>/.config/pp/testnet.env`; `home` defaults to `$HOME`, which a rehearsal points at a scratch directory. */
export const keyFilePath = (home: string = homedir()): string => join(home, ".config", "pp", "testnet.env")

// secp256k1's group order and BN254's scalar field: an L1 key lies in [1, n), an L2 secret in [0, r).
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const BN254_R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

/** The value is a 32-byte 0x hex word in its kind's range. */
export function isKeyValue(kind: KeySpec["kind"], v: string): v is `0x${string}` {
	if (!isHex(v) || v.length !== 66) return false
	const n = BigInt(v)
	return kind === "l1" ? n > 0n && n < SECP256K1_N : n < BN254_R
}

/**
 * A fresh key from the OS's CSPRNG. Never `Fr.random()` or anything else on Aztec's foundation
 * randomness, which turns into a seeded PRNG when `SEED` is set. An L2 secret reduces 64 bytes into the
 * field (bias below 2^-250); an L1 key redraws until it lies in [1, n).
 */
export function generateKey(kind: KeySpec["kind"], bytes: (n: number) => Uint8Array = randomBytes): `0x${string}` {
	const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const
	const draw = (n: number) => BigInt(`0x${Buffer.from(bytes(n)).toString("hex")}`)
	if (kind === "l2") return hex(draw(64) % BN254_R)
	for (;;) {
		const k = draw(32)
		if (k > 0n && k < SECP256K1_N) return hex(k)
	}
}

const NAME = /^[A-Z][A-Z0-9_]*$/

/** Owned by `uid`, the right type, and no permission bit for group or others. */
function assertPrivate(st: Stats, what: string, path: string, uid: number, dir: boolean): void {
	if (dir ? !st.isDirectory() : !st.isFile()) throw new GuardError("keys", `${path} is not a ${what}`)
	if (st.uid !== uid) throw new GuardError("keys", `${path} belongs to uid ${st.uid}, not this user`)
	if ((st.mode & 0o077) !== 0)
		throw new GuardError(
			"keys",
			`${path} has mode ${(st.mode & 0o777).toString(8)}; the ${what} must be ${dir ? "0700" : "0600"} or tighter`,
		)
}

/** The key file's directory: a real directory (not a link) owned by `uid` with no group or other bits. */
export function assertKeyDir(dir: string, uid: number): void {
	let st: Stats
	try {
		st = lstatSync(dir)
	} catch (e) {
		throw new GuardError("keys", `${dir} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}); run \`keys\` to create it`)
	}
	assertPrivate(st, "directory", dir, uid, true)
}

/**
 * Every line's name, in order, with each value kept only for `wanted`. Blank lines are skipped; any
 * other line must be `NAME=value`, and a name may appear once.
 * @throws GuardError `keys` naming the line number or the variable
 */
export function parseKeyLines(text: string, path: string, wanted: ReadonlySet<string>): { names: string[]; values: Map<string, string> } {
	const names: string[] = []
	const values = new Map<string, string>()
	for (const [i, line] of text.split("\n").entries()) {
		if (line.trim() === "") continue
		const at = line.indexOf("=")
		const name = at > 0 ? line.slice(0, at) : ""
		if (!NAME.test(name)) throw new GuardError("keys", `${path} line ${i + 1} is not NAME=value`)
		if (names.includes(name)) throw new GuardError("keys", `${path} names ${name} twice`)
		names.push(name)
		if (wanted.has(name)) values.set(name, line.slice(at + 1))
	}
	return { names, values }
}

/**
 * Opens the file without following a link and checks the open descriptor, so a swap after the check is
 * not read. A second hard link is refused: it could carry the real key file into a scratch home.
 */
export function openKeyFile(path: string, flags: number, uid: number): number {
	let fd: number
	try {
		fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600)
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code
		throw new GuardError("keys", `${path} cannot be opened (${code ?? "error"}); run \`keys\` to create it`)
	}
	try {
		const st = fstatSync(fd)
		assertPrivate(st, "file", path, uid, false)
		if (st.nlink !== 1) throw new GuardError("keys", `${path} has ${st.nlink} hard links; the key file must have exactly one`)
		return fd
	} catch (e) {
		closeSync(fd)
		throw e
	}
}

/**
 * Reads exactly `specs` from the key file, after its directory and the file pass the owner and mode checks.
 * @throws GuardError `keys` naming the file, a line number or the first missing or malformed variable
 */
export function loadKeys(
	specs: readonly KeySpec[],
	path: string = keyFilePath(),
	uid: number = process.getuid?.() ?? -1,
): Record<string, `0x${string}`> {
	assertKeyDir(dirname(path), uid)
	const fd = openKeyFile(path, constants.O_RDONLY, uid)
	let text: string
	try {
		text = readFileSync(fd, "utf8")
	} finally {
		closeSync(fd)
	}
	const { values } = parseKeyLines(text, path, new Set(specs.map((s) => s.name)))
	const out: Record<string, `0x${string}`> = {}
	for (const { name, kind } of specs) {
		const v = values.get(name)
		if (v === undefined) throw new GuardError("keys", `${path} has no ${name}; run \`keys\` to add it`)
		if (!isKeyValue(kind, v))
			throw new GuardError("keys", `${name} in ${path} is not a valid ${kind === "l1" ? "L1 private key" : "L2 field element"}`)
		out[name] = v
	}
	return out
}

/** Appends `lines` in one write and syncs; `after` is the file's text, so a last line without a newline stays whole. */
export function appendKeyLines(fd: number, after: string, lines: readonly string[]): void {
	if (lines.length === 0) return
	const lead = after.length > 0 && !after.endsWith("\n") ? "\n" : ""
	writeSync(fd, `${lead}${lines.join("\n")}\n`)
	fsyncSync(fd)
}
