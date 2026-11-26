import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCeremonyTable } from "./ceremony.ts"
import { sha256Hex, treeDigest } from "./digest.ts"
import { downloadVerified, type LfsPointer, parsePointer, requestBatch } from "./lfs.ts"

const BODY = new TextEncoder().encode("verifier bytes")
const POINTER: LfsPointer = { oid: sha256Hex(BODY), size: BODY.length }
const OTHER_OID = "0".repeat(64)

function fakeFetch(respond: (url: string) => Response): typeof fetch {
	return (async (input: string | URL | Request) => respond(String(input))) as typeof fetch
}

function batchFetch(objects: unknown[]): typeof fetch {
	return fakeFetch(() => Response.json({ objects }))
}

describe("git-lfs pointer", () => {
	test("parses oid and size", () => {
		const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${POINTER.oid}\nsize ${POINTER.size}\n`
		expect(parsePointer(text)).toEqual(POINTER)
	})

	test("rejects a file that is not a pointer", () => {
		expect(() => parsePointer("pragma solidity ^0.8.0;")).toThrow("not a git-lfs pointer")
	})
})

describe("LFS batch response", () => {
	const download = { actions: { download: { href: "https://lfs.example/o" } } }

	test("rejects a response that omits a requested object", async () => {
		await expect(requestBatch("o/r", [POINTER], batchFetch([]))).rejects.toThrow("omitted")
	})

	test("rejects a response that adds an unrequested object", async () => {
		const objects = [
			{ oid: POINTER.oid, ...download },
			{ oid: OTHER_OID, ...download },
		]
		await expect(requestBatch("o/r", [POINTER], batchFetch(objects))).rejects.toThrow("unrequested")
	})
})

describe("verified download", () => {
	const dl = { href: "https://lfs.example/o" }

	test("returns bytes that match the pointer", async () => {
		const got = await downloadVerified(
			dl,
			POINTER,
			fakeFetch(() => new Response(BODY)),
		)
		expect(sha256Hex(got)).toBe(POINTER.oid)
	})

	test("rejects tampered bytes of the right size", async () => {
		const tampered = new Uint8Array(BODY)
		tampered[0] = (tampered[0] ?? 0) ^ 1
		await expect(
			downloadVerified(
				dl,
				POINTER,
				fakeFetch(() => new Response(tampered)),
			),
		).rejects.toThrow("does not match pointer")
	})

	test("stops a stream that exceeds the pointer size", async () => {
		const long = new Uint8Array(BODY.length + 1)
		await expect(
			downloadVerified(
				dl,
				POINTER,
				fakeFetch(() => new Response(long)),
			),
		).rejects.toThrow("exceeds its pointer size")
	})
})

test("ceremony table parses rows and refuses duplicates", () => {
	const row = (c: string) => `| \`${c}\` | \`${POINTER.oid}\` |`
	expect(parseCeremonyTable(`| Circuit | sha |\n|---|---|\n${row("deposit")}\n${row("transact_1x1")}`).get("transact_1x1")).toBe(
		POINTER.oid,
	)
	expect(() => parseCeremonyTable(`${row("deposit")}\n${row("deposit")}`)).toThrow("twice")
})

test("tree digest changes when a file's bytes or a symlink's target change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pp-env-digest-"))
	try {
		await writeFile(join(dir, "a.sol"), "contract A {}")
		await symlink("a.sol", join(dir, "link"))
		const before = await treeDigest(dir)
		await writeFile(join(dir, "a.sol"), "contract B {}")
		const afterEdit = await treeDigest(dir)
		await rm(join(dir, "link"))
		await symlink("elsewhere.sol", join(dir, "link"))
		expect(new Set([before, afterEdit, await treeDigest(dir)]).size).toBe(3)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
