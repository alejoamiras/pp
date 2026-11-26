import { readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
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

/**
 * Fails a stack build whose module graph holds any file under `src/data/fixtures/` (reachable code,
 * even if tree-shaken, means an import path exists) or whose output names the fixture marker.
 */
export function stackBuildGuard(appRoot: string): Plugin {
	const fixturesDir = join(appRoot, "src", "data", "fixtures")
	let logger: Logger | undefined
	return {
		name: "pp:stack-build-guard",
		apply: "build",
		configResolved(config) {
			logger = config.logger
		},
		generateBundle(_options, bundle) {
			const ids = [...this.getModuleIds()]
			const files = Object.values(bundle).map((out) => ({
				fileName: out.fileName,
				text:
					out.type === "chunk"
						? out.code
						: typeof out.source === "string"
							? out.source
							: Buffer.from(out.source).toString("latin1"),
			}))
			const leaks = fixtureLeaks(ids, files, fixturesDir)
			if (leaks.length > 0) this.error(`stack build ships fixture code:\n  ${leaks.join("\n  ")}`)
			logger?.info(`${GUARD_PASSED}: ${ids.length} modules, ${files.length} files, no fixture module, no ${FIXTURE_MARKER}`)
		},
	}
}
