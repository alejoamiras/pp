import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
	CANONICAL_CODE_FIXTURE,
	CIRCUITS_DIR,
	CONTRACTS_DIR,
	FETCH_RECIPE,
	forgeLibraryFlags,
	lfsPaths,
	PPV2_COMMIT,
	PPV2_REPO,
	PPV2_TARBALL_SHA256,
	PROVING_CIRCUITS,
	URL_PINNED_DEPS,
	zkeyCircuit,
} from "../pins.ts"
import { assertFfiDisabled, cleanEnv, forgeBin, forgeEnv, run } from "../tools.ts"
import { parseCeremonyTable } from "./ceremony.ts"
import { listFiles, sha256File, sha256Hex, treeDigest } from "./digest.ts"
import { downloadVerified, type LfsPointer, parsePointer, requestBatch } from "./lfs.ts"

export type LfsRecord = LfsPointer & { path: string }
export type ReadyRecord = {
	recipe: number
	commit: string
	tarballSha256: string
	lfs: LfsRecord[]
	urlPinnedDeps: Record<string, string>
	manifestSha256: string
	timingsMs: Record<string, number>
	bytes: Record<string, number>
}
type Log = (line: string) => void

export function cacheParent(): string {
	return process.env.PP_V2_DIR ?? join(homedir(), ".cache/pp/ppv2")
}

export function targetDir(): string {
	return join(cacheParent(), `${PPV2_COMMIT}-r${FETCH_RECIPE}`)
}

// Every byte a later step consumes: Forge inputs and outputs, the code fixture, the SDK builds, the proving circuits.
const MANIFEST_ROOTS = [
	`${CONTRACTS_DIR}/foundry.toml`,
	`${CONTRACTS_DIR}/remappings.txt`,
	`${CONTRACTS_DIR}/script`,
	`${CONTRACTS_DIR}/src`,
	`${CONTRACTS_DIR}/out`,
	`${CONTRACTS_DIR}/cache`,
	CANONICAL_CODE_FIXTURE,
	"packages/core-sdk/dist",
	"packages/evm-sdk/dist",
	"packages/mock-asp/dist",
	...PROVING_CIRCUITS.map((c) => `${CIRCUITS_DIR}/${c}`),
]

async function manifest(src: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const root of MANIFEST_ROOTS) {
		const abs = join(src, root)
		const rels = (await stat(abs)).isDirectory() ? (await listFiles(abs)).map((r) => join(root, r)) : [root]
		for (const rel of rels) files[rel] = await sha256File(join(src, rel))
	}
	return files
}

function manifestDigest(files: Record<string, string>): string {
	return sha256Hex(
		Object.entries(files)
			.map(([p, h]) => `${p}\0${h}\n`)
			.join(""),
	)
}

async function urlPinnedDigests(src: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	for (const name of Object.keys(URL_PINNED_DEPS)) {
		out[name] = await treeDigest(await realpath(join(src, CONTRACTS_DIR, "node_modules", name)))
	}
	return out
}

function assertUrlPinned(got: Record<string, string>): void {
	for (const [name, want] of Object.entries(URL_PINNED_DEPS)) {
		if (got[name] !== want) throw new Error(`${name} tree digest ${got[name]} does not match the pin ${want}`)
	}
}

async function downloadTarball(dest: string): Promise<void> {
	const res = await fetch(`https://codeload.github.com/${PPV2_REPO}/tar.gz/${PPV2_COMMIT}`)
	if (!res.ok || !res.body) throw new Error(`tarball download failed: HTTP ${res.status}`)
	const bytes = new Uint8Array(await res.arrayBuffer())
	const got = sha256Hex(bytes)
	if (got !== PPV2_TARBALL_SHA256) throw new Error(`tarball sha256 ${got} does not match the pin ${PPV2_TARBALL_SHA256}`)
	await writeFile(dest, bytes)
}

async function hydrateLfs(src: string, log: Log): Promise<LfsRecord[]> {
	const ceremony = parseCeremonyTable(await readFile(join(src, "packages/circuits/CEREMONY.md"), "utf8"))
	const records: LfsRecord[] = []
	for (const path of lfsPaths()) {
		const pointer = parsePointer(await readFile(join(src, path), "utf8"))
		const circuit = zkeyCircuit(path)
		if (circuit && ceremony.get(circuit) !== pointer.oid)
			throw new Error(`${path}: pointer oid is not CEREMONY.md's hash for ${circuit}`)
		records.push({ path, ...pointer })
	}
	const downloads = await requestBatch(PPV2_REPO, records)
	for (const r of records) {
		const dl = downloads.get(r.oid)
		if (!dl) throw new Error(`no download for ${r.path}`)
		await writeFile(join(src, r.path), await downloadVerified(dl, r))
	}
	log(`lfs: ${records.length} objects verified`)
	return records
}

async function disableFfi(contracts: string): Promise<void> {
	const path = join(contracts, "foundry.toml")
	const text = await readFile(path, "utf8")
	await writeFile(path, text.replace(/^(\s*ffi\s*=\s*)true\b/gm, "$1false"))
	await assertFfiDisabled(contracts)
}

async function timed<T>(timings: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now()
	const out = await fn()
	timings[key] = Math.round(performance.now() - t0)
	return out
}

const PNPM_FILTERS = ["@privacy-pools-v2/evm-sdk...", "@privacy-pools-v2/mock-asp...", "@privacy-pools-v2/contracts"]
const SDK_PACKAGES = ["@privacy-pools-v2/core-sdk", "@privacy-pools-v2/evm-sdk", "@privacy-pools-v2/mock-asp"]

type Staged = { lfs: LfsRecord[]; urlPinnedDeps: Record<string, string>; timings: Record<string, number> }

/** Everything that does not depend on the tree's final path: sources, LFS objects, pnpm install, SDK builds. */
async function stageSources(staging: string, log: Log): Promise<Staged> {
	const timings: Record<string, number> = {}
	const src = join(staging, "src")
	const tarball = join(staging, "src.tar.gz")
	await timed(timings, "tarball", () => downloadTarball(tarball))
	await mkdir(src)
	await run(["tar", "xzf", tarball, "-C", src, "--strip-components=1", "--no-same-owner"])
	const lfs = await timed(timings, "lfs", () => hydrateLfs(src, log))
	await disableFfi(join(src, CONTRACTS_DIR))
	const pnpmEnv = cleanEnv({ CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" })
	const filters = PNPM_FILTERS.flatMap((f) => ["--filter", f])
	await timed(timings, "pnpmInstall", () =>
		run(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", ...filters], { cwd: src, env: pnpmEnv }),
	)
	const urlPinnedDeps = await urlPinnedDigests(src)
	assertUrlPinned(urlPinnedDeps)
	log("pnpm: installed; url-pinned deps verified")
	const sdkFilters = SDK_PACKAGES.flatMap((p) => ["--filter", p])
	await timed(timings, "sdkBuild", () => run(["pnpm", "-r", ...sdkFilters, "run", "build"], { cwd: src, env: pnpmEnv }))
	log("sdk: built")
	return { lfs, urlPinnedDeps, timings }
}

/**
 * Forge's cache records the project's absolute paths, so the contracts are built at their final
 * location: a build moved afterwards recompiles from scratch on first use and rewrites the shared tree.
 */
async function buildInPlace(target: string, staged: Staged, log: Log): Promise<void> {
	const { lfs, urlPinnedDeps, timings } = staged
	const src = join(target, "src")
	const contracts = join(src, CONTRACTS_DIR)
	await assertFfiDisabled(contracts)
	const forgeBuild = [forgeBin(), "build", "--skip", "test", "--root", contracts, ...forgeLibraryFlags()]
	await timed(timings, "forgeBuild", () => run(forgeBuild, { env: forgeEnv() }))
	log(`forge: built (${timings.forgeBuild} ms)`)
	const files = await manifest(src)
	await writeFile(join(target, "manifest.json"), `${JSON.stringify(files, null, "\t")}\n`)
	const bytes = Object.fromEntries(await Promise.all(lfs.map(async (r) => [r.path, (await stat(join(src, r.path))).size] as const)))
	const ready: ReadyRecord = {
		recipe: FETCH_RECIPE,
		commit: PPV2_COMMIT,
		tarballSha256: PPV2_TARBALL_SHA256,
		lfs,
		urlPinnedDeps,
		manifestSha256: manifestDigest(files),
		timingsMs: timings,
		bytes,
	}
	// ready.json is the completion marker, so it appears atomically and last.
	const tmp = join(target, `ready.json.${process.pid}`)
	await writeFile(tmp, `${JSON.stringify(ready, null, "\t")}\n`)
	await rename(tmp, join(target, "ready.json"))
}

/** Re-checks a published tree against its pins; any drift throws. */
export async function verifyFetched(target: string): Promise<ReadyRecord> {
	const ready = JSON.parse(await readFile(join(target, "ready.json"), "utf8")) as ReadyRecord
	if (ready.recipe !== FETCH_RECIPE || ready.commit !== PPV2_COMMIT)
		throw new Error(`${target}: ready.json is for another recipe or commit`)
	const tarball = await sha256File(join(target, "src.tar.gz"))
	if (tarball !== PPV2_TARBALL_SHA256) throw new Error(`${target}: kept tarball no longer matches its pin`)
	const src = join(target, "src")
	const recorded = JSON.parse(await readFile(join(target, "manifest.json"), "utf8")) as Record<string, string>
	const current = await manifest(src)
	for (const [path, hash] of Object.entries(recorded)) {
		if (current[path] !== hash) throw new Error(`${target}: ${path} changed since the fetch; delete the directory and fetch again`)
	}
	for (const path of Object.keys(current)) if (!(path in recorded)) throw new Error(`${target}: unexpected file ${path}`)
	if (manifestDigest(recorded) !== ready.manifestSha256) throw new Error(`${target}: manifest.json does not match ready.json`)
	assertUrlPinned(await urlPinnedDigests(src))
	return ready
}

function incomplete(target: string): Error {
	return new Error(
		`${target} has no ready.json: another fetch is building it, or one crashed. If none is running, delete it and fetch again.`,
	)
}

/**
 * Stages sources privately, claims the target with one rename, builds the contracts there, and
 * writes ready.json last. Only a tree with ready.json is ever used.
 */
export async function fetchPpv2(log: Log = () => {}): Promise<{ target: string; fetched: boolean }> {
	const target = targetDir()
	if (existsSync(join(target, "ready.json"))) {
		await verifyFetched(target)
		return { target, fetched: false }
	}
	if (existsSync(target)) throw incomplete(target)
	await mkdir(dirname(target), { recursive: true })
	const staging = await mkdtemp(join(cacheParent(), ".staging-"))
	let staged: Staged
	try {
		staged = await stageSources(staging, log)
		await rename(staging, target)
	} catch (err) {
		await rm(staging, { recursive: true, force: true })
		throw existsSync(target) ? incomplete(target) : err
	}
	await buildInPlace(target, staged, log)
	await verifyFetched(target)
	return { target, fetched: true }
}
