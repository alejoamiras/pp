import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { Logger, Plugin } from "vite"
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

/** Build-time-only code: the contract artifacts the target derives the SponsoredFPC from, and that derivation. */
const BUILD_ONLY = [/[\\/]@aztec-labs[\\/]noir-contracts\.js[\\/]/, /[\\/]src[\\/]build[\\/]sponsored-fpc\.ts$/]

/** Modules in a bundle's graph that only the build may load. */
export function buildOnlyModules(moduleIds: Iterable<string>): string[] {
	return [...moduleIds].filter((id) => BUILD_ONLY.some((re) => re.test(id.replace(/^\0/, "")))).map((id) => `module ${id}`)
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
 * Fails a stack build whose module graph holds any file under `src/data/fixtures/` or any build-only
 * module (reachable code, even if tree-shaken, means an import path exists), or whose written output
 * names the fixture marker. The output directory is read back rather than the bundle, because Vite
 * copies `public/` beside the bundle and the scan must cover everything that ships.
 */
export function stackBuildGuard(appRoot: string): Plugin {
	const fixturesDir = join(appRoot, "src", "data", "fixtures")
	let logger: Logger | undefined
	let outDir = ""
	let ids: string[] = []
	return {
		name: "pp:stack-build-guard",
		apply: "build",
		configResolved(config) {
			logger = config.logger
			outDir = resolve(config.root, config.build.outDir)
		},
		generateBundle() {
			ids = [...this.getModuleIds()]
		},
		writeBundle(options) {
			const files = readOutput(options.dir ?? outDir)
			const leaks = fixtureLeaks(ids, files, fixturesDir)
			if (leaks.length > 0) this.error(`stack build ships fixture code:\n  ${leaks.join("\n  ")}`)
			const buildOnly = buildOnlyModules(ids)
			if (buildOnly.length > 0) this.error(`stack build ships build-time-only code:\n  ${buildOnly.join("\n  ")}`)
			logger?.info(
				`${GUARD_PASSED}: ${ids.length} modules, ${files.length} files, no fixture module, no ${FIXTURE_MARKER}, no build-only module`,
			)
		},
	}
}
