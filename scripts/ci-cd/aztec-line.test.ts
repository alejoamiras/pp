import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, posix } from "node:path"

/**
 * One Aztec line per install. The line publishes on two version tracks: every `@aztec-labs/*`
 * package sits at the `@aztec-labs/aztec.js` pin, and every `@aztec-foundation/*` package at the
 * version that aztec.js itself depends on, read from the lockfile so the next line needs no edit.
 * `@aztec-foundation/aztec-standards` follows the standards repository's own tags and sits at its
 * declared pin. Nothing resolves under the retired `@aztec/*` scope: from 6.0.0 the line depends on
 * stock viem, not the `@aztec/viem` fork. A second version in the tree means two `Fr` classes, which
 * fail at runtime rather than at install. The TXE server's lockfile is checked too: its oracle must
 * speak the line the contracts compile against. Viem is held to one exact version for the same
 * reason: the Aztec packages and ours pass its clients and types across.
 */
const ROOT = join(import.meta.dir, "..", "..")
const LOCKFILES = ["bun.lock", "contracts/bridge/aztec/txe-server/bun.lock"]
const PIN_SOURCES = ["packages/bridge-core/package.json"]
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const STANDARDS = "@aztec-foundation/aztec-standards"
/** The standards pin's source: labelled-token profiles the stock Token as its gate baseline. */
const STANDARDS_SOURCE = "packages/labelled-token/package.json"

type Specs = Record<string, string>
type Manifest = {
	name?: string
	workspaces?: string[]
	optionalDependencies?: Specs
	dependencies?: Specs
	devDependencies?: Specs
	peerDependencies?: Specs
	patchedDependencies?: Specs
	overrides?: Record<string, string | Specs>
}
type Lock = { packages: Record<string, [string, string, { dependencies?: Record<string, string> }?, string?]> }

const manifest = (path: string): Manifest => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Manifest
const lockOf = (path: string): Lock => Bun.JSONC.parse(readFileSync(join(ROOT, path), "utf8")) as Lock
const pinOf = (path: string, name: string): string | undefined => manifest(path).dependencies?.[name]

const LABS = pinOf(PIN_SOURCES[0], "@aztec-labs/aztec.js")
const STANDARDS_PIN = manifest(STANDARDS_SOURCE).devDependencies?.[STANDARDS]
const FOUNDATION = lockOf("bun.lock").packages["@aztec-labs/aztec.js"]?.[2]?.dependencies?.["@aztec-foundation/l1-artifacts"]

/** The version a package must resolve at, or `undefined` when the line does not govern it. */
function expectedVersion(name: string): string | undefined {
	if (name === STANDARDS) return STANDARDS_PIN
	if (name.startsWith("@aztec-labs/")) return LABS
	if (name.startsWith("@aztec-foundation/")) return FOUNDATION
	return undefined
}

/** `name@version` identities of every package a lockfile resolves. */
function resolved(lockfile: string): { name: string; version: string }[] {
	return Object.values(lockOf(lockfile).packages).map(([id]) => {
		const at = id.lastIndexOf("@")
		return { name: id.slice(0, at), version: id.slice(at + 1) }
	})
}

const MANIFESTS = [
	"package.json",
	"contracts/bridge/aztec/txe-server/package.json",
	...(manifest("package.json").workspaces ?? []).flatMap((glob) => [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: ROOT })]),
]

test("every workspace the CI pin readers consult names the same exact pins", () => {
	expect(LABS).toMatch(EXACT)
	expect(STANDARDS_PIN).toMatch(EXACT)
	for (const path of PIN_SOURCES) {
		expect(pinOf(path, "@aztec-labs/aztec.js"), path).toBe(LABS)
	}
})

test("every manifest declares each Aztec package at exactly its line version", () => {
	const off = MANIFESTS.flatMap((path) => {
		const m = manifest(path)
		return [m.dependencies, m.devDependencies, m.peerDependencies]
			.flatMap((section) => Object.entries(section ?? {}))
			.filter(([name, spec]) => expectedVersion(name) !== undefined && spec !== expectedVersion(name))
			.map(([name, spec]) => `${path}: ${name}@${spec} (want ${expectedVersion(name)})`)
	})
	expect(MANIFESTS.length).toBeGreaterThan(3)
	expect(off).toEqual([])
})

/**
 * The app's dependency closure holds one exact viem: what ships to a browser or the bot passes viem
 * clients and types to the Aztec packages, and two copies split at runtime. The roots are every
 * workspace under `apps/`, the ASP bot and the libraries they build on; a workspace joins through its
 * runtime dependencies, never its devDependencies. Dev and test packages outside the closure are not held
 * to it: pp-env matches the pool SDK checkout's own viem, and local-stack boots both chains.
 */
const CLOSURE_ROOTS = ["@pp/asp-bot", "@pp/bridge-core", "@pp/bridge-spec", "@pp/pool-client", "@pp/label-paths"]

type Workspace = { dir: string; manifest: Manifest }
type LockDeps = { dependencies?: Specs; optionalDependencies?: Specs; peerDependencies?: Specs }
type ResolvedLock = { packages: Record<string, [string, string?, LockDeps?, string?]> }

const runtimeSpecs = (m: LockDeps | undefined): Specs => ({ ...m?.dependencies, ...m?.optionalDependencies, ...m?.peerDependencies })
const runtimeDeps = (m: LockDeps | undefined) => Object.keys(runtimeSpecs(m))

/**
 * The workspace a dependency of the workspace in `fromDir` names: the target of a `workspace:` alias,
 * by name or by a path relative to `fromDir`, else its own key.
 */
function workspaceOf(fromDir: string, dep: string, spec: string, workspaces: Map<string, Workspace>): string | undefined {
	const target = spec.startsWith("workspace:") ? spec.slice("workspace:".length) : ""
	if (target.startsWith(".") || target.startsWith("/")) {
		const dir = posix.normalize(posix.join(fromDir, target)).replace(/\/$/, "")
		return [...workspaces].find(([, w]) => w.dir === dir)?.[0]
	}
	const named = /^((?:@[^@/]+\/)?[^@]+)/.exec(target)?.[1]
	if (named && workspaces.has(named)) return named
	return workspaces.has(dep) ? dep : undefined
}

function workspacesByName(): Map<string, Workspace> {
	const paths = (manifest("package.json").workspaces ?? []).flatMap((glob) => [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: ROOT })])
	return new Map(paths.map((path) => [manifest(path).name ?? path, { dir: dirname(path), manifest: manifest(path) }]))
}

/** Workspace names reachable from the app's roots over runtime dependencies. */
function appClosure(workspaces: Map<string, Workspace>): Set<string> {
	const queue = [...workspaces].filter(([name, w]) => w.dir.startsWith("apps/") || CLOSURE_ROOTS.includes(name)).map(([name]) => name)
	const members = new Set<string>()
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		if (members.has(name)) continue
		members.add(name)
		const w = workspaces.get(name)
		queue.push(...Object.entries(runtimeSpecs(w?.manifest)).flatMap(([dep, spec]) => workspaceOf(w?.dir ?? "", dep, spec, workspaces) ?? []))
	}
	return members
}

/** The viem versions a manifest section names, its own entry or an `npm:viem@` alias. */
const viemSpecs = (section: Specs | undefined) =>
	Object.entries(section ?? {}).flatMap(([name, spec]) =>
		name === "viem" ? [spec] : spec.startsWith("npm:viem@") ? [spec.slice("npm:viem@".length)] : [],
	)

/** The lockfile key `dep` resolves to from the package at `key`: the nearest nesting first, then the hoisted copy. */
function resolveKey(lock: ResolvedLock, key: string, dep: string): string | undefined {
	const parts = key.split("/")
	const names: string[] = []
	for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i])
	for (let n = names.length; n >= 0; n--) {
		const candidate = [...names.slice(0, n), dep].join("/")
		if (candidate in lock.packages) return candidate
	}
	return undefined
}

/** Every viem version the closure's workspaces resolve, their devDependencies included; any workspace reached ends that path. */
function viemReached(lock: ResolvedLock, workspaces: Map<string, Workspace>, members: Set<string>): Set<string> {
	const stack: string[] = []
	const follow = (from: string, deps: string[]) => {
		for (const dep of deps) {
			const key = resolveKey(lock, from, dep)
			if (key) stack.push(key)
		}
	}
	for (const name of members) {
		const m = workspaces.get(name)?.manifest
		follow(name, [...runtimeDeps(m), ...Object.keys(m?.devDependencies ?? {})])
	}
	const versions = new Set<string>()
	const seen = new Set<string>()
	for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
		if (seen.has(key)) continue
		seen.add(key)
		const [id, , meta] = lock.packages[key]
		if (id.includes("@workspace:")) continue
		if (id.startsWith("viem@")) versions.add(id.slice("viem@".length))
		follow(key, runtimeDeps(meta))
	}
	return versions
}

test("the app's dependency closure declares and resolves one exact viem", () => {
	const workspaces = workspacesByName()
	const members = appClosure(workspaces)
	expect([...members]).toEqual(expect.arrayContaining(["@pp/bridge-core", "@pp/bridge-spec"]))
	const declared = [...members].flatMap((name) => {
		const m = workspaces.get(name)?.manifest
		return [m?.dependencies, m?.devDependencies, m?.optionalDependencies, m?.peerDependencies].flatMap(viemSpecs)
	})
	const overridden = Object.entries(manifest("package.json").overrides ?? {}).flatMap(([name, v]) =>
		typeof v === "string" ? viemSpecs({ [name]: v }) : viemSpecs(v),
	)
	const specs = new Set([...declared, ...overridden])
	expect(specs.size, [...specs].join(", ")).toBe(1)
	const [viem] = specs
	expect(viem).toMatch(EXACT)
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as ResolvedLock
	expect([...viemReached(lock, workspaces, members)]).toEqual([viem])
})

test("the closure walk finds a nested second viem and stops at a workspace outside the closure", () => {
	const ws = (dir: string, m: Manifest): [string, Workspace] => [m.name ?? dir, { dir, manifest: m }]
	const workspaces = new Map([
		ws("packages/bridge-core", { name: "@pp/bridge-core", dependencies: { x: "1.0.0" }, devDependencies: { "@pp/pp-env": "workspace:*" } }),
		ws("packages/pp-env", { name: "@pp/pp-env", dependencies: { viem: "2.45.3" } }),
		ws("packages/local-stack", { name: "@pp/local-stack", dependencies: { "@pp/bridge-core": "workspace:*", "@pp/pp-env": "workspace:*" } }),
	])
	const lock: ResolvedLock = {
		packages: {
			"@pp/bridge-core": ["@pp/bridge-core@workspace:packages/bridge-core"],
			"@pp/pp-env": ["@pp/pp-env@workspace:packages/pp-env"],
			"@pp/local-stack": ["@pp/local-stack@workspace:packages/local-stack"],
			"@pp/pp-env/viem": ["viem@2.45.3", "", {}],
			x: ["x@1.0.0", "", { dependencies: { viem: "2.40.0" } }],
			"x/viem": ["viem@2.40.0", "", {}],
			viem: ["viem@2.57.1", "", {}],
		},
	}
	const members = appClosure(workspaces)
	expect([...members]).toEqual(["@pp/bridge-core"])
	expect([...viemReached(lock, workspaces, members)]).toEqual(["2.40.0"])
	for (const alias of ["workspace:@pp/pp-env", "workspace:../pp-env"]) {
		const aliasing = { name: "@pp/bridge-core", dependencies: { env: alias } }
		const aliased = new Map(workspaces).set("@pp/bridge-core", { dir: "packages/bridge-core", manifest: aliasing })
		expect([...appClosure(aliased)].sort(), alias).toEqual(["@pp/bridge-core", "@pp/pp-env"])
	}
})

test("the foundation version is the exact one the locked aztec.js requires", () => {
	expect(FOUNDATION).toMatch(EXACT)
})

test.each(LOCKFILES)("%s resolves a single Aztec line", (lockfile) => {
	const strays = resolved(lockfile)
		.filter(({ name, version }) => {
			if (name.startsWith("@aztec/")) return true
			const expected = expectedVersion(name)
			return expected !== undefined && version !== expected
		})
		.map(({ name, version }) => `${name}@${version} (want ${expectedVersion(name) ?? "none"})`)
	expect(strays).toEqual([])
})

test("every patched dependency names the foundation version, so its patch still applies", () => {
	const patched = Object.entries(manifest("package.json").patchedDependencies ?? {})
	expect(patched.length).toBeGreaterThan(0)
	for (const [key, file] of patched) {
		const at = key.lastIndexOf("@")
		expect(expectedVersion(key.slice(0, at)), key).toBe(FOUNDATION)
		expect(key.slice(at + 1), key).toBe(FOUNDATION)
		expect(existsSync(join(ROOT, file)), file).toBe(true)
	}
})
