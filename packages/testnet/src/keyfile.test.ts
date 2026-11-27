import { readFileSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { generatePrivateKey } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { generateKey, isKeyValue, KEY_NAMES, keyFilePath, loadKeys } from "./keyfile"
import { RUN_KEYS } from "./keys"
import { scratchHome, writeKeyFile } from "./test-support"

const UID = process.getuid?.() ?? -1
const GUARDIAN = [{ name: "GUARDIAN_KEY", kind: "l1" }] as const
const refusal = (f: () => unknown): string => {
	try {
		f()
	} catch (e) {
		expect(e).toMatchObject({ name: "GuardError", guard: "keys" })
		return (e as Error).message
	}
	throw new Error("expected a refusal")
}

describe("the key file loader", () => {
	it("reads only the names asked for, and refuses a missing name, a duplicate or a malformed line without echoing a value", () => {
		const guardian = generatePrivateKey()
		const other = generatePrivateKey()
		const path = writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${guardian}`, "", `CANARY_OWNER_KEY=${other}`])
		expect(loadKeys(GUARDIAN, path, UID)).toEqual({ GUARDIAN_KEY: guardian })
		expect(refusal(() => loadKeys([{ name: "CANARY_SENDER_KEY", kind: "l1" }], path, UID))).toMatch(/no CANARY_SENDER_KEY/)
		const twice = writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${guardian}`, `GUARDIAN_KEY=${other}`])
		expect(refusal(() => loadKeys(GUARDIAN, twice, UID))).toMatch(/GUARDIAN_KEY twice/)
		const garbled = writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${guardian}`, `${other}`])
		const message = refusal(() => loadKeys(GUARDIAN, garbled, UID))
		expect(message).toMatch(/line 2 is not NAME=value/)
		for (const v of [guardian, other]) expect(message).not.toContain(v.slice(2))
	})

	it("refuses a value outside its kind's range, naming only the variable", () => {
		const outOfRange = "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff5e7"
		const path = writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${outOfRange}`, "BOT_POSTER_SECRET=SENTINEL-NOT-A-KEY"])
		const message = refusal(() => loadKeys(GUARDIAN, path, UID))
		expect(message).toMatch(/GUARDIAN_KEY .* not a valid L1 private key/)
		expect(message).not.toContain("ffff")
		const poster = refusal(() => loadKeys([{ name: "BOT_POSTER_SECRET", kind: "l2" }], path, UID))
		expect(poster).toMatch(/BOT_POSTER_SECRET .* not a valid L2 field element/)
		expect(poster).not.toContain("SENTINEL")
		expect([isKeyValue("l1", `0x${"0".repeat(64)}`), isKeyValue("l2", `0x${"0".repeat(64)}`), isKeyValue("l2", outOfRange)]).toEqual([
			false,
			true,
			false,
		])
	})

	it("refuses a looser directory or file, a link, another owner, and an absent file", () => {
		const key = generatePrivateKey()
		expect(
			refusal(() => loadKeys(GUARDIAN, writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${key}`], { dir: 0o755, file: 0o600 }), UID)),
		).toMatch(/mode 755; the directory must be 0700/)
		expect(
			refusal(() => loadKeys(GUARDIAN, writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${key}`], { dir: 0o700, file: 0o640 }), UID)),
		).toMatch(/mode 640; the file must be 0600/)
		const target = writeKeyFile(scratchHome(), [`GUARDIAN_KEY=${key}`])
		const linked = join(dirname(writeKeyFile(scratchHome(), [])), "linked.env")
		symlinkSync(target, linked)
		expect(refusal(() => loadKeys(GUARDIAN, linked, UID))).toMatch(/cannot be opened \(ELOOP\)/)
		expect(refusal(() => loadKeys(GUARDIAN, target, UID + 1))).toMatch(/belongs to uid/)
		expect(refusal(() => loadKeys(GUARDIAN, keyFilePath(scratchHome()), UID))).toMatch(/run `keys`/)
	})
})

describe("generateKey", () => {
	it("draws from the given CSPRNG bytes: an L2 secret reduces 64 bytes into the field, an L1 key redraws out of range", () => {
		const r = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n
		const l2 = generateKey("l2", (n) => new Uint8Array(n).fill(0xff))
		expect(BigInt(l2)).toBe(((1n << 512n) - 1n) % r)
		const draws = [new Uint8Array(32), new Uint8Array(32).fill(0xff), new Uint8Array(32).fill(0x11)]
		expect(generateKey("l1", () => draws.shift() as Uint8Array)).toBe(`0x${"11".repeat(32)}`)
		expect(draws).toHaveLength(0)
		expect([isKeyValue("l1", generateKey("l1")), isKeyValue("l2", generateKey("l2"))]).toEqual([true, true])
	})
})

describe("the key names", () => {
	it("testnet.env.example lists every name, with no value", () => {
		const text = readFileSync(fileURLToPath(new URL("../testnet.env.example", import.meta.url)), "utf8")
		const assignments = text.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"))
		expect(assignments).toEqual(KEY_NAMES.map((k) => `${k.name}=`))
	})

	it("no command holds the guardian key together with another key", () => {
		for (const [run, specs] of Object.entries(RUN_KEYS))
			if (specs.some((s) => s.name === "GUARDIAN_KEY"))
				expect(
					specs.map((s) => s.name),
					run,
				).toEqual(["GUARDIAN_KEY"])
	})
})
