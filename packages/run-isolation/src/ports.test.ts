import { afterAll, beforeAll, expect, test } from "bun:test"
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { claimPort, claimRows, OwnerHoldsRows, portOwner, registeredPorts, releasePorts, releaseRows, rowsOwnedBy } from "./ports.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "ports-test-"))
const saved = process.env.PP_PORTS_REGISTRY
beforeAll(() => {
	process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
})
afterAll(() => {
	if (saved === undefined) delete process.env.PP_PORTS_REGISTRY
	else process.env.PP_PORTS_REGISTRY = saved
	rmSync(dir, { recursive: true, force: true })
})

test(
	"release outlasts a dead holder's lock instead of returning with its rows intact",
	async () => {
		const runId = "ports-test-release"
		await claimPort(runId, "pp-env-test")
		expect(rowsOwnedBy(runId)).toBe(1)
		// A holder that died 7 s ago: its lock turns stale 8 s into the wait, so only a wait past the stale threshold frees it.
		const lock = join(dir, "ports.md.lock")
		writeFileSync(lock, "")
		const diedAt = (Date.now() - 7_000) / 1000
		utimesSync(lock, diedAt, diedAt)
		await releasePorts(runId)
		expect(rowsOwnedBy(runId)).toBe(0)
	},
	{ timeout: 30_000 },
)

test("release drops only the rows its run owns, even when a run ID equals another row's service", async () => {
	await claimPort("ports-test-other", "pp-env-anvil")
	await claimPort("pp-env-anvil", "pp-env-test")
	await releasePorts("pp-env-anvil")
	expect(rowsOwnedBy("ports-test-other")).toBe(1)
	await releasePorts("ports-test-other")
})

test("release leaves a row whose owner only contains the run id, and one that names it in another column", async () => {
	const runId = "ports-test-exact"
	await claimRows(`${runId}-pool`, { anvil: 40_001 }, process.pid)
	await claimRows("ports-test-neighbour", { [runId]: 40_002 }, process.pid)
	await claimRows(runId, { anvil: 40_003 }, process.pid)
	expect(await releaseRows(runId)).toBe(true)
	expect([rowsOwnedBy(runId), rowsOwnedBy(`${runId}-pool`), rowsOwnedBy("ports-test-neighbour")]).toEqual([0, 1, 1])
	await releasePorts(`${runId}-pool`)
	await releasePorts("ports-test-neighbour")
})

test("a claim refuses an owner or service a release could not match", async () => {
	for (const [owner, service] of [
		["run ", "anvil"],
		["run", "a|b"],
		["run\nx", "anvil"],
	] as const)
		await expect(claimRows(owner, { [service]: 40_010 }, process.pid)).rejects.toThrow("cannot be a registry cell")
	expect(registeredPorts().has(40_010)).toBe(false)
})

test("a claim writes the rows it checked, though the caller's object changes while it waits for the lock", async () => {
	const lock = join(dir, "ports.md.lock")
	writeFileSync(lock, "held")
	const rows: Record<string, number> = { "pp-env-test": 40_011 }
	const claim = claimRows("ports-test-snapshot", rows, process.pid)
	rows["a|b"] = 40_012
	rmSync(lock)
	await claim
	expect([40_011, 40_012].filter((p) => registeredPorts().has(p))).toEqual([40_011])
	await releasePorts("ports-test-snapshot")
})

test("a port's owner is the run whose row lists it, until that run releases it", async () => {
	const port = await claimPort("ports-test-owner", "pp-env-test")
	expect(portOwner(port)).toBe("ports-test-owner")
	await releasePorts("ports-test-owner")
	expect(portOwner(port)).toBeUndefined()
})

test("of two concurrent sole claims by one owner, exactly one is written", async () => {
	const claims = await Promise.allSettled([
		claimPort("ports-test-sole", "a", { sole: true }),
		claimPort("ports-test-sole", "b", { sole: true }),
	])
	expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1)
	expect(claims.find((c) => c.status === "rejected")?.reason).toBeInstanceOf(OwnerHoldsRows)
	expect(rowsOwnedBy("ports-test-sole")).toBe(1)
	await releasePorts("ports-test-sole")
})

const ROW = /^\| \d+ \| [^|]+ \| [^|]+ \| [^|]+ \| \d+ \| [^|]+ \|$/

/** Every line after the header is a whole row, no port is listed twice, and every seed row is there once. */
function intact(text: string, seed: Set<string>): boolean {
	const rows = text
		.split("\n")
		.slice(1)
		.filter((l) => l.length > 0)
	const seeded = rows.filter((l) => l.includes("| ports-test-seed |"))
	return (
		seeded.length === seed.size &&
		seeded.every((l) => seed.has(l)) &&
		rows.every((l) => ROW.test(l)) &&
		new Set(rows.map((l) => l.split("|")[1])).size === rows.length
	)
}

// Node truncates before it writes; Bun writes over the old bytes and truncates after, so its tear shows
// only when a release shortens the file and moves the rows behind the removed ones.
test.each(["bun", "node"])(
	"a reader never sees the registry torn while a %s process rewrites it",
	async (runtime) => {
		const registry = join(dir, `torn-${runtime}.md`)
		const rows = Array.from({ length: 2_000 }, (_, i) => `| ${20_000 + i} | svc | ports-test-seed | /w | 1 | t |`)
		const seed = new Set(rows)
		writeFileSync(registry, `# header\n${rows.join("\n")}\n`)
		const writer = `import { claimRows, releaseRows } from ${JSON.stringify(join(import.meta.dir, "ports.ts"))}
	for (const end = Date.now() + 2_000; Date.now() < end; ) {
		await claimRows("ports-test-x", { svc: 41_001, other: 41_002 }, 1)
		await claimRows("ports-test-y", { svc: 41_003, other: 41_004 }, 1)
		await releaseRows("ports-test-x")
		await releaseRows("ports-test-y")
	}`
		const args = runtime === "node" ? ["node", "--input-type=module", "-e", writer] : ["bun", "-e", writer]
		const child = Bun.spawn(args, { env: { ...process.env, PP_PORTS_REGISTRY: registry }, stderr: "inherit" })
		let rewritten = 0
		let torn = 0
		for (const end = Date.now() + 1_800; Date.now() < end; ) {
			const text = readFileSync(registry, "utf8")
			if (!intact(text, seed)) torn++
			else if (text.includes("| ports-test-x |")) rewritten++
		}
		expect(await child.exited).toBe(0)
		// Reads that saw the writer's rows prove the reads overlapped its rewrites.
		expect({ overlapped: rewritten > 0, torn }).toEqual({ overlapped: true, torn: 0 })
	},
	30_000,
)

test("a rewrite keeps a symlinked registry's link and its file's exact mode, creates a dangling link's file, and leaves no temporary file", async () => {
	const home = mkdtempSync(join(dir, "linked-"))
	writeFileSync(join(home, "shared.md"), "# header\n", { mode: 0o660 })
	chmodSync(join(home, "shared.md"), 0o660)
	symlinkSync("shared.md", join(home, "ports.md"))
	symlinkSync("missing.md", join(home, "dangling.md"))
	// `..` in a link inside a symlinked directory resolves from the directory's real place: b/far.md.
	mkdirSync(join(home, "b/sub"), { recursive: true })
	writeFileSync(join(home, "b/far.md"), "# header\n")
	symlinkSync("../far.md", join(home, "b/sub/ports.md"))
	symlinkSync("b/sub", join(home, "alias"))
	const umask = process.umask(0o077)
	try {
		for (const link of ["ports.md", "dangling.md", "alias/ports.md"]) {
			process.env.PP_PORTS_REGISTRY = join(home, link)
			await claimRows(`ports-test-${link}`, { anvil: 40_020 }, process.pid)
		}
	} finally {
		process.umask(umask)
		process.env.PP_PORTS_REGISTRY = join(dir, "ports.md")
	}
	const mode = (file: string) => statSync(join(home, file)).mode & 0o777
	expect([lstatSync(join(home, "ports.md")).isSymbolicLink(), lstatSync(join(home, "dangling.md")).isSymbolicLink()]).toEqual([
		true,
		true,
	])
	expect([mode("shared.md"), mode("missing.md")]).toEqual([0o660, 0o600])
	expect(readFileSync(join(home, "shared.md"), "utf8")).toContain("| 40020 | anvil | ports-test-ports.md |")
	expect(readFileSync(join(home, "missing.md"), "utf8")).toContain("| 40020 | anvil | ports-test-dangling.md |")
	expect(readFileSync(join(home, "b/far.md"), "utf8")).toContain("| 40020 | anvil | ports-test-alias/ports.md |")
	expect(readdirSync(home).sort()).toEqual(["alias", "b", "dangling.md", "missing.md", "ports.md", "shared.md"])
	expect(readdirSync(join(home, "b")).sort()).toEqual(["far.md", "sub"])
})
