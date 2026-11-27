/**
 * The Noir crate manifest, `contracts/crates.json`: every crate in the repository, the gates each one
 * runs, and the commit every git dependency tag must resolve to (nargo has no lockfile, so a moved
 * tag would change the build silently). `compile.sh`, `run-txe-tests.sh` and the bridge-contracts
 * workflow read it through this module, so a new crate is one entry.
 *
 *   bun scripts/ci-cd/crates.ts list <parity|nargo|txe>   crate names, one per line
 *   bun scripts/ci-cd/crates.ts matrix <parity|txe>       the same names as a JSON array
 *   bun scripts/ci-cd/crates.ts get <name> <field>        path | kind | txe.floor | txe.stage | txe.build (one per line)
 *   bun scripts/ci-cd/crates.ts aztec-version             the aztec-nr version every crate pins, without the `v`
 *   bun scripts/ci-cd/crates.ts nargo-test [name...]      each crate's nargo gate (default: every crate with one):
 *                                                        `aztec-nargo test --force [filter]` with at least `floor`
 *                                                        passing, or its `check` script
 *   bun scripts/ci-cd/crates.ts check-pins [name...]      every git tag the named crates reach through nargo's cache
 *                                                        is pinned, fetched and at its recorded commit; with no
 *                                                        name, the pins must be exactly what all crates reach
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, posix } from "node:path"

export const ROOT = join(import.meta.dir, "..", "..")
export const MANIFEST = "contracts/crates.json"

export type Kind = "contract" | "bin" | "lib"
export type Gate = "parity" | "nargo" | "txe"

export interface Crate {
	name: string
	/** Repo-relative directory holding the crate's Nargo.toml. */
	path: string
	kind: Kind
	/** A rebuild must reproduce the committed target/*.json: class id or program hash, and the ABI. */
	parity: boolean
	/** Plain `aztec-nargo test --force`, optionally filtered by name, with at least `floor` passing;
	 *  or a repo-relative `check` script that runs the suite and requires its tests by name. */
	nargo?: { filter?: string; floor: number } | { check: string }
	/** The TXE suite: `txe-manifest.txt` names at least `floor` tests and every one must pass;
	 *  `stage` lists repo-relative artifacts the server loads from the crate's target/. */
	txe?: { floor: number; stage: string[] }
}

export interface Pin {
	/** `owner/name` on github.com, as nargo caches it. */
	repo: string
	tag: string
	commit: string
}

export interface Manifest {
	crates: Crate[]
	pins: Pin[]
}

const NAME = /^[a-z][a-z0-9_]*$/
const REPO = /^[\w.-]+\/[\w.-]+$/
const COMMIT = /^[0-9a-f]{40}$/
const CRATE_KEYS = new Set(["name", "path", "kind", "parity", "nargo", "txe"])

type Raw = Record<string, unknown>

const fail = (where: string, why: string): never => {
	throw new Error(`${MANIFEST}: ${where}: ${why}`)
}

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v)

function floor(where: string, v: unknown): number {
	return Number.isInteger(v) && (v as number) > 0 ? (v as number) : fail(where, "floor must be a positive integer")
}

/** The parsed Nargo.toml of a crate directory, or undefined when there is none. */
export function nargoToml(root: string, path: string): Raw | undefined {
	const file = join(root, path, "Nargo.toml")
	return existsSync(file) ? (Bun.TOML.parse(readFileSync(file, "utf8")) as Raw) : undefined
}

/** A repo-relative path in canonical form: `./x`, `x//y` or `x/` would name the same file under another spelling. */
const repoRelative = (s: unknown): s is string =>
	typeof s === "string" && s !== "" && !s.startsWith("/") && !s.split("/").includes("..") && posix.normalize(s) === s && !s.endsWith("/")

function parseNargo(name: string, v: unknown, root: string): Crate["nargo"] {
	if (!isRecord(v)) return fail(name, "nargo must be an object")
	if (v.check !== undefined) {
		if (Object.keys(v).length !== 1) fail(name, "nargo.check stands alone: the script owns the filter and the floor")
		if (!repoRelative(v.check) || !existsSync(join(root, v.check))) fail(name, "nargo.check must name a repo-relative script")
		return { check: v.check as string }
	}
	if (v.filter !== undefined && (typeof v.filter !== "string" || v.filter === "")) fail(name, "nargo.filter must be a name")
	return { ...(v.filter === undefined ? {} : { filter: v.filter as string }), floor: floor(`${name}.nargo`, v.floor) }
}

function parseTxe(name: string, v: unknown, root: string, path: string): Crate["txe"] {
	if (!isRecord(v)) return fail(name, "txe must be an object")
	if (!existsSync(join(root, path, "txe-manifest.txt"))) fail(name, `${path}/txe-manifest.txt is missing`)
	const stage = v.stage ?? []
	if (!Array.isArray(stage) || !stage.every(repoRelative)) fail(name, "txe.stage must list repo-relative paths")
	return { floor: floor(`${name}.txe`, v.floor), stage: stage as string[] }
}

function parseCrate(v: unknown, root: string): Crate {
	if (!isRecord(v)) return fail("crates", "every entry must be an object")
	const name = typeof v.name === "string" && NAME.test(v.name) ? v.name : fail(String(v.name), `name must match ${NAME}`)
	for (const key of Object.keys(v)) if (!CRATE_KEYS.has(key)) fail(name, `unknown key ${key}`)
	const path = repoRelative(v.path) ? v.path : fail(name, "path must be repo-relative")
	const type = (nargoToml(root, path)?.package as Raw | undefined)?.type
	if (type === undefined) fail(name, `${path}/Nargo.toml has no package type`)
	if (v.kind !== type) fail(name, `kind ${String(v.kind)} differs from Nargo.toml's type ${String(type)}`)
	if (v.parity !== undefined && typeof v.parity !== "boolean") fail(name, "parity must be a boolean")
	if (v.parity === true && type === "lib") fail(name, "a lib crate builds no artifact to compare")
	return {
		name,
		path,
		kind: type as Kind,
		parity: v.parity === true,
		...(v.nargo === undefined ? {} : { nargo: parseNargo(name, v.nargo, root) }),
		...(v.txe === undefined ? {} : { txe: parseTxe(name, v.txe, root, path) }),
	}
}

function parsePin(v: unknown): Pin {
	if (!isRecord(v)) return fail("pins", "every entry must be an object")
	const where = `pin ${String(v.repo)}@${String(v.tag)}`
	if (typeof v.repo !== "string" || !REPO.test(v.repo)) fail(where, "repo must be owner/name")
	if (typeof v.tag !== "string" || v.tag === "") fail(where, "tag must be set")
	if (typeof v.commit !== "string" || !COMMIT.test(v.commit)) fail(where, "commit must be a full 40-hex sha")
	return { repo: v.repo as string, tag: v.tag as string, commit: v.commit as string }
}

function uniqueBy<T>(items: T[], key: (t: T) => string, what: string): void {
	const seen = new Set<string>()
	for (const item of items) {
		const k = key(item)
		if (seen.has(k)) fail(what, `${k} is listed twice`)
		seen.add(k)
	}
}

/** Parses and validates the manifest against the crates on disk; throws naming the first problem. */
export function parseManifest(v: unknown, root = ROOT): Manifest {
	if (!isRecord(v) || !Array.isArray(v.crates) || !Array.isArray(v.pins)) return fail("top level", "needs crates and pins arrays")
	const crates = v.crates.map((c) => parseCrate(c, root))
	const pins = v.pins.map(parsePin)
	uniqueBy(crates, (c) => c.name, "crates")
	uniqueBy(crates, (c) => c.path, "crates")
	uniqueBy(pins, (p) => `${p.repo}@${p.tag}`, "pins")
	for (const c of crates) {
		for (const staged of c.txe?.stage ?? []) {
			const producer = crates.find((p) => staged.startsWith(`${p.path}/`))
			if (producer && !(producer.parity && staged.startsWith(`${producer.path}/target/`)))
				fail(c.name, `stages ${staged}, which is not a parity crate's target/ artifact and so is never rebuilt`)
		}
	}
	return { crates, pins }
}

export function loadManifest(root = ROOT): Manifest {
	return parseManifest(JSON.parse(readFileSync(join(root, MANIFEST), "utf8")), root)
}

export const cratesWith = (m: Manifest, gate: Gate): Crate[] => m.crates.filter((c) => (gate === "parity" ? c.parity : c[gate]))

export function crateNamed(m: Manifest, name: string): Crate {
	return m.crates.find((c) => c.name === name) ?? fail(name, "no such crate")
}

/** Every git dependency a crate declares, as `owner/name@tag` keyed to the dependency's alias. */
export function gitDeps(root: string, crate: Crate): { alias: string; repo: string; tag: string }[] {
	return gitDepsAt(join(root, crate.path)).map(({ alias, repo, tag }) => ({ alias, repo, tag }))
}

const repoOf = (url: unknown) =>
	String(url)
		.replace(/^https:\/\/github\.com\//, "")
		.replace(/\/$/, "")
		.replace(/\.git$/, "")

function gitDepsAt(dir: string): { alias: string; repo: string; tag: string; directory: string }[] {
	const deps = (nargoToml(dir, "")?.dependencies ?? {}) as Record<string, Raw>
	return Object.entries(deps)
		.filter(([, d]) => typeof d.git === "string")
		.map(([alias, d]) => ({ alias, repo: repoOf(d.git), tag: String(d.tag), directory: String(d.directory ?? "") }))
}

/**
 * Every git tag the crates reach, directly or through a fetched dependency's own Nargo.toml (path
 * dependencies included), as `owner/name@tag`. A tag nargo has not fetched is listed in `unfetched`
 * and not walked.
 */
export function reachableTags(
	m: Manifest,
	nargoHome: string,
	root = ROOT,
	from: Crate[] = m.crates,
): { tags: Set<string>; unfetched: string[] } {
	const tags = new Set<string>()
	const unfetched: string[] = []
	const seen = new Set<string>()
	const walk = (dir: string) => {
		if (seen.has(dir)) return
		seen.add(dir)
		const deps = (nargoToml(dir, "")?.dependencies ?? {}) as Record<string, Raw>
		for (const d of Object.values(deps)) if (typeof d.path === "string") walk(join(dir, d.path))
		for (const dep of gitDepsAt(dir)) visit(dep)
	}
	const visit = ({ repo, tag, directory }: ReturnType<typeof gitDepsAt>[number]) => {
		const id = `${repo}@${tag}`
		const fetched = join(nargoHome, "github.com", repo, tag)
		const present = existsSync(fetched)
		if (!tags.has(id) && !present) unfetched.push(id)
		tags.add(id)
		if (present) walk(join(fetched, directory))
	}
	for (const c of from) walk(join(root, c.path))
	return { tags, unfetched }
}

/** The one aztec-nr version the crates pin; two different tags fail, since one toolchain builds them all. */
export function aztecVersion(m: Manifest, root = ROOT): string {
	const tags = new Set(
		m.crates.flatMap((c) =>
			gitDeps(root, c)
				.filter((d) => d.repo === "aztec-labs-eng/aztec-nr")
				.map((d) => d.tag),
		),
	)
	if (tags.size !== 1) fail("crates", `expected one aztec-nr tag, found ${[...tags].join(", ") || "none"}`)
	return [...tags][0].replace(/^v/, "")
}

/** Colour codes only: stripping cursor moves as well would join digits printed apart into one count. */
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/** Sums nargo's per-package "N tests passed" lines. */
export function passedCount(output: string): number {
	return [...output.replace(SGR, "").matchAll(/(\d+) tests? passed/g)].reduce((n, m) => n + Number(m[1]), 0)
}

function nargoTest(m: Manifest, name: string): void {
	const crate = crateNamed(m, name)
	const gate = crate.nargo ?? fail(name, "has no nargo gate")
	if ("check" in gate) {
		const run = spawnSync("bun", [gate.check], { cwd: ROOT, stdio: "inherit" })
		if (run.error) fail(name, `bun did not run: ${run.error.message}`)
		if (run.status !== 0) fail(name, `${gate.check} exited ${run.status}`)
		return
	}
	const { filter, floor: min } = gate
	const home = process.env.AZTEC_HOME ?? join(homedir(), ".aztec/versions", aztecVersion(m))
	const run = spawnSync(join(home, "bin/aztec-nargo"), ["test", "--force", ...(filter ? [filter] : [])], {
		cwd: join(ROOT, crate.path),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	process.stdout.write(run.stdout ?? "")
	process.stderr.write(run.stderr ?? "")
	if (run.error) fail(name, `aztec-nargo did not run: ${run.error.message}`)
	if (run.status !== 0) fail(name, `aztec-nargo test exited ${run.status}`)
	// nargo exits 0 when a filter matches nothing, so the count is the proof the suite ran.
	const passed = passedCount(`${run.stdout}${run.stderr}`)
	if (passed < min) fail(name, `${passed} tests passed; the floor is ${min}`)
	console.log(`${name}: ${passed} tests passed (floor ${min})`)
}

/** Problems with the pinned tags nargo has fetched into `nargoHome`; a tag not fetched is one. */
export function pinProblems(pins: Pin[], nargoHome: string): string[] {
	return pins.flatMap(({ repo, tag, commit }) => {
		const dir = join(nargoHome, "github.com", repo, tag)
		if (!existsSync(dir)) return [`${repo}@${tag} is not fetched at ${dir}; build a crate that uses it first`]
		const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim()
		return head === commit ? [] : [`${repo}@${tag} resolved to ${head || "nothing"}; ${MANIFEST} records ${commit}`]
	})
}

/**
 * The crates to rebuild before `name`'s TXE suite: every parity crate whose committed artifact the
 * suite stages, then `name` itself. The server loads those artifacts, so a stale one tests old code.
 */
export function txeBuild(m: Manifest, name: string): string[] {
	const crate = crateNamed(m, name)
	const stage = (crate.txe ?? fail(name, "has no txe gate")).stage
	const deps = cratesWith(m, "parity").filter((c) => c !== crate && stage.some((s) => s.startsWith(`${c.path}/target/`)))
	return [...deps.map((c) => c.name), name]
}

function field(m: Manifest, crate: Crate, key: string): string {
	switch (key) {
		case "path":
			return crate.path
		case "kind":
			return crate.kind
		case "txe.floor":
			return String(crate.txe?.floor ?? fail(crate.name, "has no txe gate"))
		case "txe.stage":
			return (crate.txe ?? fail(crate.name, "has no txe gate")).stage.join("\n")
		case "txe.build":
			return txeBuild(m, crate.name).join("\n")
		default:
			return fail(crate.name, `unknown field ${key}`)
	}
}

/**
 * Each CI job fetches its own copy of every tag, so each checks the crates it built against the cache
 * it used; a moved tag cannot slip in between jobs. Only a run over every crate can also name a pin
 * that nothing reaches.
 */
function checkPins(m: Manifest, names: string[]): void {
	const home = join(homedir(), "nargo")
	const { tags, unfetched } = reachableTags(m, home, ROOT, names.length ? names.map((n) => crateNamed(m, n)) : m.crates)
	const pinned = new Set(m.pins.map((p) => `${p.repo}@${p.tag}`))
	const problems = [
		...unfetched.map((t) => `${t} is not fetched; build a crate that uses it first`),
		...[...tags].filter((t) => !pinned.has(t)).map((t) => `${t} is reached through the crates but not pinned in ${MANIFEST}`),
		...(names.length ? [] : [...pinned].filter((t) => !tags.has(t)).map((t) => `${t} is pinned but no crate reaches it`)),
		...pinProblems(
			m.pins.filter((p) => tags.has(`${p.repo}@${p.tag}`)),
			home,
		),
	]
	for (const p of problems) console.error(`✖ ${p}`)
	if (problems.length) process.exit(1)
	console.log(`${tags.size} reached tags pinned at their recorded commits${names.length ? ` (${names.join(", ")})` : ""}`)
}

function gateArg(v: string | undefined): Gate {
	return v === "parity" || v === "nargo" || v === "txe" ? v : fail("usage", `expected parity, nargo or txe, got ${v}`)
}

function main(argv: string[]): void {
	const m = loadManifest()
	const [cmd, a, b, ...rest] = argv
	if (cmd === "list")
		console.log(
			cratesWith(m, gateArg(a))
				.map((c) => c.name)
				.join("\n"),
		)
	else if (cmd === "matrix") console.log(JSON.stringify(cratesWith(m, gateArg(a)).map((c) => c.name)))
	else if (cmd === "get") console.log(field(m, crateNamed(m, a), b))
	else if (cmd === "aztec-version") console.log(aztecVersion(m))
	else if (cmd === "nargo-test") {
		const names = a === undefined ? cratesWith(m, "nargo").map((c) => c.name) : [a, b, ...rest].filter(Boolean)
		for (const name of names) nargoTest(m, name)
	} else if (cmd === "check-pins") checkPins(m, [a, b, ...rest].filter(Boolean))
	else fail("usage", "see the header of scripts/ci-cd/crates.ts")
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2))
	} catch (e) {
		console.error((e as Error).message)
		process.exit(1)
	}
}
