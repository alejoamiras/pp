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
type Overrides = { [selector: string]: string | Overrides }
type Manifest = {
	name?: string
	workspaces?: unknown
	optionalDependencies?: Specs
	dependencies?: Specs
	devDependencies?: Specs
	peerDependencies?: Specs
	patchedDependencies?: Specs
	overrides?: Overrides
	catalog?: Specs
	catalogs?: Record<string, Specs>
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

/** The package names along a lockfile key, outermost first: `a/@s/b` is `a` then `@s/b`. */
function keyNames(key: string): string[] {
	const parts = key.split("/")
	const names: string[] = []
	for (let i = 0; i < parts.length; i++) names.push(parts[i].startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i])
	return names
}

/** A `name@version` identity split after the name, so a `workspace:` path holding `@` stays in the version. */
function identity(id: string): { name: string; version: string } {
	const at = id.indexOf("@", id.startsWith("@") ? 1 : 0)
	return { name: id.slice(0, at), version: id.slice(at + 1) }
}

/**
 * The entries of `lock` that leave the Aztec line: an Aztec package at another version, a key under
 * a governed name that resolves some other package (an override alias), or anything under the
 * retired `@aztec/*` scope.
 */
function lockStrays(lock: Lock): string[] {
	return Object.entries(lock.packages).flatMap(([key, [id]]) => {
		const { name, version } = identity(id)
		const keyName = keyNames(key).at(-1) ?? key
		const governed = expectedVersion(keyName) !== undefined
		const stray =
			name.startsWith("@aztec/") ||
			keyName.startsWith("@aztec/") ||
			(governed && name !== keyName) ||
			(expectedVersion(name) !== undefined && version !== expectedVersion(name))
		return stray ? [`${key} -> ${id} (want ${expectedVersion(name) ?? expectedVersion(keyName) ?? "none"})`] : []
	})
}

/** The root's workspace globs. An object form would hide every workspace from these guards and `audit-summary.ts`. */
function workspaceGlobs(root: Manifest = manifest("package.json")): string[] {
	if (Array.isArray(root.workspaces) && root.workspaces.every((g) => typeof g === "string")) return root.workspaces
	throw new Error("package.json: keep `workspaces` an array of globs; a catalog goes at the top level")
}

const workspaceManifests = () => workspaceGlobs().flatMap((glob) => [...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: ROOT })])

const MANIFESTS = ["package.json", "contracts/bridge/aztec/txe-server/package.json", ...workspaceManifests()]

test("every workspace the CI pin readers consult names the same exact pins", () => {
	expect(LABS).toMatch(EXACT)
	expect(STANDARDS_PIN).toMatch(EXACT)
	for (const path of PIN_SOURCES) {
		expect(pinOf(path, "@aztec-labs/aztec.js"), path).toBe(LABS)
	}
})

/** Every manifest section a package can be installed from. */
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

/** The package `name` at `spec` installs and its range: an `npm:` alias's target, else `name` itself. Bun trims the spec. */
function installs(name: string, spec: string): { target: string; range: string | undefined } {
	const trimmed = spec.trim()
	const alias = /^npm:((?:@[^@/]+\/)?[^@]+)(?:@([\s\S]*))?$/.exec(trimmed)
	return alias ? { target: alias[1], range: alias[2] } : { target: name, range: trimmed }
}

/**
 * Whether `name` at `spec` leaves the line: a governed name at anything but its exact version
 * (a `$name` reference included) or aliased to another package, or an `npm:` alias to a governed
 * package without exactly its version.
 */
function specStray(name: string, spec: string): boolean {
	const { target, range } = installs(name, spec)
	if (expectedVersion(name) !== undefined && target !== name) return true
	return expectedVersion(target) !== undefined && range !== expectedVersion(target)
}

/** The Aztec packages `m` declares at anything but their line version. */
const offLine = (path: string, m: Manifest): string[] =>
	SECTIONS.flatMap((section) => Object.entries(m[section] ?? {}))
		.filter(([name, spec]) => specStray(name, spec))
		.map(([name, spec]) => `${path}: ${name}@${spec}`)

/**
 * The package an override selector targets: the last of `a>b>c`, each a name with an optional
 * `@range` qualifier. Any other shape is `undefined`, so a selector this cannot read fails the check.
 */
function selectorTarget(selector: string): string | undefined {
	const names = selector.split(">").map((part) => /^((?:@[^@/\s>]+\/)?[^@/\s>]+)(?:@[^\s>/]+)?$/.exec(part.trim())?.[1])
	return names.every((n) => n !== undefined) ? names.at(-1) : undefined
}

type OverrideRule = { label: string; target: string | undefined; spec: string }

/** Every rule an `overrides` tree sets, at any depth, with its target (`undefined` when its selector cannot be read). */
function overrideRules(where: string, rules: Overrides, parent?: string): OverrideRule[] {
	return Object.entries(rules).flatMap(([selector, rule]) => {
		const target = selector === "." ? parent : selectorTarget(selector)
		const label = `${where} > ${selector}`
		if (typeof rule !== "string") return target === undefined ? [{ label, target, spec: "" }] : overrideRules(label, rule, target)
		return [{ label, target, spec: rule }]
	})
}

/** The `overrides` rules that move an Aztec package off the line or cannot be read. */
const overrideStrays = (where: string, rules: Overrides): string[] =>
	overrideRules(where, rules).flatMap(({ label, target, spec }) => {
		if (target === undefined) return [`${label}: an override selector this check cannot read`]
		return specStray(target, spec) ? [`${label}: ${spec}`] : []
	})

/** Catalog entries of `m` that hold an Aztec package or alias one: the line stays exact in each manifest. */
function catalogStrays(path: string, m: Manifest): string[] {
	const nested = (m.workspaces ?? {}) as { catalog?: Specs; catalogs?: Record<string, Specs> }
	const catalogs = [m.catalog, ...Object.values(m.catalogs ?? {}), nested.catalog, ...Object.values(nested.catalogs ?? {})]
	return catalogs
		.flatMap((c) => Object.entries(c ?? {}))
		.filter(([name, spec]) => expectedVersion(name) !== undefined || expectedVersion(installs(name, spec).target) !== undefined)
		.map(([name, spec]) => `${path}: catalog ${name}@${spec}`)
}

/** Every way a manifest can move an Aztec package off the line. */
const manifestStrays = (path: string, m: Manifest): string[] => [
	...offLine(path, m),
	...overrideStrays(`${path}: overrides`, m.overrides ?? {}),
	...catalogStrays(path, m),
]

test("every manifest declares, overrides and catalogs each Aztec package at exactly its line version", () => {
	expect(MANIFESTS.length).toBeGreaterThan(3)
	expect(MANIFESTS.flatMap((path) => manifestStrays(path, manifest(path)))).toEqual([])
})

test("an alias, an override or a catalog cannot move an Aztec package off the line", () => {
	const labs = "@aztec-labs/aztec.js"
	const stdlib = "@aztec-labs/stdlib"
	const held: [Manifest, number][] = [
		[{ optionalDependencies: { sdk: `npm:${labs}@${LABS}` } }, 0],
		[{ optionalDependencies: { sdk: `npm:${labs}@^${LABS}` } }, 1],
		[{ optionalDependencies: { sdk: `npm:${labs}` } }, 1],
		[{ optionalDependencies: { sdk: ` npm:${labs}@^${LABS}` } }, 1],
		[{ dependencies: { [labs]: `npm:left-pad@${LABS}` } }, 1],
		[{ overrides: { [STANDARDS]: "npm:tslib@2.8.1" } }, 1],
		[{ overrides: { [stdlib]: `$${labs}` } }, 1],
		[{ overrides: { "@0xbow/sdk": { [stdlib]: `^${LABS}` } } }, 1],
		[{ overrides: { [stdlib]: { ".": `^${LABS}` } } }, 1],
		[{ overrides: { [`@pp/bridge-core>${stdlib}`]: `^${LABS}` } }, 1],
		[{ overrides: { [`${stdlib}@${LABS}`]: `^${LABS}` } }, 1],
		[{ overrides: { [`@pp/bridge-core/${stdlib}`]: LABS as string } }, 1],
		[{ overrides: { [`@pp/bridge-core@0.1.0/${stdlib}`]: `^${LABS}` } }, 1],
		[{ dependencies: { sdk: `npm:${stdlib}@^5.0.0\n || ^${LABS}` } }, 1],
		[{ catalog: { sdk: `npm:${stdlib}@^5.0.0\n || ^${LABS}` } }, 1],
		[{ overrides: { ".": LABS as string } }, 1],
		[{ overrides: { "@0xbow/sdk": { viem: "2.57.1" }, [`${labs}>viem`]: "2.57.1", [labs]: LABS as string } }, 0],
		[{ catalog: { [stdlib]: LABS as string } }, 1],
		[{ catalogs: { pool: { sdk: `npm:${stdlib}@${LABS}` } } }, 1],
		[{ catalog: { zod: "4.4.3" } }, 0],
	]
	for (const [m, n] of held) expect(manifestStrays("x", m), JSON.stringify(m)).toHaveLength(n)
})

test("workspace discovery refuses a workspaces field that is not an array of globs", () => {
	expect(workspaceGlobs({ workspaces: ["packages/*"] })).toEqual(["packages/*"])
	expect(() => workspaceGlobs({ workspaces: { packages: ["packages/*"], catalog: {} } })).toThrow(/top level/)
})

test("the manifest scan reads every section a package installs from", () => {
	for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		expect(offLine("x", { [section]: { "@aztec-labs/aztec.js": "0.0.0" } }), section).toHaveLength(1)
	}
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
	return new Map(workspaceManifests().map((path) => [manifest(path).name ?? path, { dir: dirname(path), manifest: manifest(path) }]))
}

/** Workspace names reachable from the app's roots over runtime dependencies. */
function appClosure(workspaces: Map<string, Workspace>): Set<string> {
	const queue = [...workspaces].filter(([name, w]) => w.dir.startsWith("apps/") || CLOSURE_ROOTS.includes(name)).map(([name]) => name)
	const members = new Set<string>()
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		if (members.has(name)) continue
		members.add(name)
		const w = workspaces.get(name)
		queue.push(
			...Object.entries(runtimeSpecs(w?.manifest)).flatMap(([dep, spec]) => workspaceOf(w?.dir ?? "", dep, spec, workspaces) ?? []),
		)
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
	const names = keyNames(key)
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
		return SECTIONS.map((section) => m?.[section]).flatMap(viemSpecs)
	})
	const overridden = overrideRules("package.json", manifest("package.json").overrides ?? {}).flatMap(({ target, spec }) =>
		target === undefined ? [] : viemSpecs({ [target]: spec }),
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
		ws("packages/bridge-core", {
			name: "@pp/bridge-core",
			dependencies: { x: "1.0.0" },
			devDependencies: { "@pp/pp-env": "workspace:*" },
		}),
		ws("packages/pp-env", { name: "@pp/pp-env", dependencies: { viem: "2.45.3" } }),
		ws("packages/local-stack", {
			name: "@pp/local-stack",
			dependencies: { "@pp/bridge-core": "workspace:*", "@pp/pp-env": "workspace:*" },
		}),
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
	expect(lockStrays(lockOf(lockfile))).toEqual([])
})

test("a lock key under a governed name must resolve that package, at its line version", () => {
	const lock = (key: string, id: string): Lock => ({ packages: { [key]: [id, ""] } })
	const labs = `@aztec-labs/aztec.js@${LABS}`
	expect(lockStrays(lock("@aztec-labs/aztec.js", labs))).toEqual([])
	expect(lockStrays(lock("sdk", labs))).toEqual([])
	for (const [key, id] of [
		[STANDARDS, "tslib@2.8.1"],
		["x/@aztec-labs/stdlib", "left-pad@1.3.0"],
		["a/b/sdk", `@aztec-foundation/bb.js@workspace:packages/bb@${FOUNDATION}`],
		["a/b/@aztec/viem", "viem@2.57.1"],
	]) {
		expect(lockStrays(lock(key, id)), `${key} -> ${id}`).toHaveLength(1)
	}
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
