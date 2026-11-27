import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { Logger, Plugin, Rolldown } from "vite"
import { HEADER_FILE, parseHeaderFile, type SecurityHeaders, securityHeaders } from "./headers.ts"
import type { PublicTarget } from "./target.ts"

/** The global a fixture build installs; a stack bundle that names it ships fixture code. */
export const FIXTURE_MARKER = "__ppFixtures"
/** Printed by a guard that ran and passed; `check:stack-build` requires it, so a disabled guard fails. */
export const GUARD_PASSED = "stack-build guard passed"

/** Writes the target's header set into the output, beside `index.html`. */
export function emitSecurityHeaders(target: PublicTarget): Plugin {
	return {
		name: "pp:security-headers",
		apply: "build",
		generateBundle() {
			this.emitFile({ type: "asset", fileName: HEADER_FILE, source: `${JSON.stringify(securityHeaders(target), null, "\t")}\n` })
		},
	}
}

export const TARGET_FILE = "target.json"

/** Writes the target `define` inlines, so a server can check that a build is the one it was asked to serve. */
export function emitTarget(target: PublicTarget): Plugin {
	return {
		name: "pp:target",
		apply: "build",
		generateBundle() {
			this.emitFile({ type: "asset", fileName: TARGET_FILE, source: `${JSON.stringify(target, null, "\t")}\n` })
		},
	}
}

/**
 * Serves `<outDir>/security-headers.json` on every preview response. The file is read once at startup
 * and a missing or invalid one stops preview from starting: a server without the policy must not
 * answer at all. The middleware is registered directly, not as a returned post hook, so it runs
 * before Vite's static and SPA-fallback handlers.
 */
export function previewSecurityHeaders(): Plugin {
	return {
		name: "pp:preview-security-headers",
		configurePreviewServer(server) {
			const file = join(resolve(server.config.root, server.config.build.outDir), HEADER_FILE)
			let text: string
			try {
				text = readFileSync(file, "utf8")
			} catch {
				throw new Error(`preview: ${file} is missing; serve only a build this config produced`)
			}
			const headers: SecurityHeaders = parseHeaderFile(text)
			server.middlewares.use((_req, res, next) => {
				for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
				next()
			})
		},
	}
}

/**
 * nodePolyfills aliases each Node builtin by prefix, so pool-client's `buffer/index.js` (its explicit
 * pick of the npm package) becomes a path inside the shim's file, and worker bundles get those aliases
 * without the plugin's resolver that would repair them. A plugin's aliases outrank the config's, and
 * a later plugin's outrank an earlier one's, so this goes after nodePolyfills.
 */
export function bufferSubpathAlias(shim: string): Plugin {
	return { name: "pp:buffer-subpath-alias", config: () => ({ resolve: { alias: [{ find: /^buffer\/index\.js$/, replacement: shim }] } }) }
}

export interface BundleFile {
	fileName: string
	text: string
}

/** What makes a stack bundle unshippable: fixture modules in its graph, or files naming the marker. */
export function fixtureLeaks(moduleIds: Iterable<string>, files: Iterable<BundleFile>, fixturesDir: string): string[] {
	const prefix = fixturesDir.endsWith(sep) ? fixturesDir : `${fixturesDir}${sep}`
	const leaks: string[] = []
	for (const id of moduleIds) if (id.replace(/^\0/, "").startsWith(prefix)) leaks.push(`module ${id}`)
	for (const f of files) if (f.text.includes(FIXTURE_MARKER)) leaks.push(`${f.fileName} names ${FIXTURE_MARKER}`)
	return leaks
}

/** What the guard reads of an output chunk. */
export interface ChunkView {
	fileName: string
	isEntry: boolean
	facadeModuleId: string | null
	imports: readonly string[]
	moduleIds: readonly string[]
}

const CONTRACT_ARTIFACTS = /[\\/]@aztec-labs[\\/]noir-contracts\.js[\\/]/
/** bridge-core derives the fee payer's address from this artifact when a session opens. */
const SESSION_ONLY =
	/[\\/]@aztec-labs[\\/]noir-contracts\.js[\\/](dest[\\/]SponsoredFPC\.js|artifacts[\\/]sponsored_fpc_contract-SponsoredFPC\.json)$/
/** The target's own derivation of the same address, which the page receives as a constant. */
const BUILD_DERIVATION = /[\\/]src[\\/]build[\\/]sponsored-fpc\.ts$/
/** The stack's own packages: the build reads the demo sender's address from them, and the page carries only that. */
const STACK_PACKAGES = /[\\/](packages[\\/]|@pp[\\/])(local-stack|pp-env)[\\/]/

const bare = (id: string): string => id.replace(/^\0/, "")

/** The chunks a page loads before any dynamic import: the entries and their static imports, transitively. */
function initialChunks(chunks: readonly ChunkView[]): Set<string> {
	const byName = new Map(chunks.map((c) => [c.fileName, c]))
	const seen = new Set<string>()
	const queue = chunks.filter((c) => c.isEntry).map((c) => c.fileName)
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		if (seen.has(name)) continue
		seen.add(name)
		queue.push(...(byName.get(name)?.imports ?? []))
	}
	return seen
}

/**
 * Build-time-only code in a stack bundle. The derivation, the stack's own packages and every contract
 * artifact are refused anywhere in the module graph (reachable code, even if tree-shaken, means an import path exists),
 * except the SponsoredFPC artifact, which may sit only in the chunk `sessionEntry` heads and only
 * while no entry reaches that chunk statically: the page then fetches it at sign-in, never at load.
 */
export function buildOnlyLeaks(moduleIds: Iterable<string>, chunks: readonly ChunkView[], sessionEntry: string): string[] {
	const refused = (id: string) =>
		BUILD_DERIVATION.test(id) || STACK_PACKAGES.test(id) || (CONTRACT_ARTIFACTS.test(id) && !SESSION_ONLY.test(id))
	const leaks = [...moduleIds].filter((id) => refused(bare(id))).map((id) => `module ${id}`)
	const initial = initialChunks(chunks)
	for (const c of chunks) {
		if (c.facadeModuleId === sessionEntry && !initial.has(c.fileName)) continue
		for (const id of c.moduleIds) if (SESSION_ONLY.test(bare(id))) leaks.push(`${c.fileName} holds ${id}`)
	}
	return leaks
}

function chunkViews(bundle: Rolldown.OutputBundle): ChunkView[] {
	return Object.values(bundle).flatMap((c) =>
		c.type === "chunk"
			? [{ fileName: c.fileName, isEntry: c.isEntry, facadeModuleId: c.facadeModuleId, imports: c.imports, moduleIds: c.moduleIds }]
			: [],
	)
}

/** Every file under `dir`, named relative to it with `/` separators. */
function readOutput(dir: string): BundleFile[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => {
			const path = join(e.parentPath, e.name)
			return { fileName: relative(dir, path).split(sep).join("/"), text: readFileSync(path, "latin1") }
		})
}

/**
 * Fails a stack build whose module graph holds any file under `src/data/fixtures/` (reachable code,
 * even if tree-shaken, means an import path exists), whose bundle holds build-only code outside what
 * `buildOnlyLeaks` allows, or whose written output names the fixture marker. The output directory is
 * read back rather than the bundle, because Vite copies `public/` beside the bundle and the scan must
 * cover everything that ships.
 */
export function stackBuildGuard(appRoot: string): Plugin {
	const fixturesDir = join(appRoot, "src", "data", "fixtures")
	const sessionEntry = join(appRoot, "src", "data", "adapters", "session.ts")
	let logger: Logger | undefined
	let outDir = ""
	let ids: string[] = []
	let chunks: ChunkView[] = []
	return {
		name: "pp:stack-build-guard",
		apply: "build",
		configResolved(config) {
			logger = config.logger
			outDir = resolve(config.root, config.build.outDir)
		},
		generateBundle(_options, bundle) {
			ids = [...this.getModuleIds()]
			chunks = chunkViews(bundle)
		},
		writeBundle(options) {
			const files = readOutput(options.dir ?? outDir)
			const leaks = fixtureLeaks(ids, files, fixturesDir)
			if (leaks.length > 0) this.error(`stack build ships fixture code:\n  ${leaks.join("\n  ")}`)
			const buildOnly = buildOnlyLeaks(ids, chunks, sessionEntry)
			if (buildOnly.length > 0) this.error(`stack build ships build-time-only code:\n  ${buildOnly.join("\n  ")}`)
			logger?.info(
				`${GUARD_PASSED}: ${ids.length} modules, ${chunks.length} chunks, ${files.length} files, no fixture module, no ${FIXTURE_MARKER}, no build-only code outside the session chunk`,
			)
		},
	}
}
