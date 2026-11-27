import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveExportedAsset } from "@nulo-sh/resolve-asset"
import { build } from "vite"
import { expect, test } from "vitest"
import { scratchDir } from "../../scripts/proc"
import { buildOnlyLeaks, type ChunkView, fixtureLeaks, stackBuildGuard } from "./plugins"

test("the stack guard flags fixture modules and the fixture marker, and nothing else", () => {
	const fixtures = join("/app", "src", "data", "fixtures")
	const clean = [
		join("/app", "src", "main.tsx"),
		join("/app", "src", "data", "adapters", "index.ts"),
		join("/app", "src", "data", "fixtures-old", "x.ts"),
	]
	expect(fixtureLeaks(clean, [{ fileName: "assets/index.js", text: "const fixtures = 1" }], fixtures)).toEqual([])
	const leaks = fixtureLeaks(
		[...clean, join(fixtures, "index.ts"), `\0${join(fixtures, "connector.ts")}?used`],
		[{ fileName: "assets/index.js", text: "window.__ppFixtures={}" }],
		fixtures,
	)
	expect(leaks).toHaveLength(3)
})

const STORE = "/repo/node_modules/.bun/@aztec-labs+noir-contracts.js@6.0.0/node_modules/@aztec-labs/noir-contracts.js"
const FPC_JS = join(STORE, "dest", "SponsoredFPC.js")
const SESSION = "/app/src/data/adapters/session.ts"

/** The app's shape: an entry, a chunk it imports, and the session behind a dynamic import. */
function chunks(at: { entry?: string[]; shared?: string[]; session?: string[]; other?: string[] }, sessionStatic = false): ChunkView[] {
	return [
		{ fileName: "index.js", isEntry: true, facadeModuleId: "/app/index.html", imports: ["shared.js"], moduleIds: at.entry ?? [] },
		{
			fileName: "shared.js",
			isEntry: false,
			facadeModuleId: null,
			imports: sessionStatic ? ["session.js"] : [],
			moduleIds: at.shared ?? [],
		},
		{ fileName: "session.js", isEntry: false, facadeModuleId: SESSION, imports: ["shared.js"], moduleIds: at.session ?? [] },
		{
			fileName: "connector.js",
			isEntry: false,
			facadeModuleId: "/app/src/data/wallet/connector.ts",
			imports: [],
			moduleIds: at.other ?? [],
		},
	]
}

test("the stack guard lets the SponsoredFPC artifact into the lazy session chunk alone, and refuses other build-only code anywhere", () => {
	expect(buildOnlyLeaks([FPC_JS], chunks({ session: [FPC_JS] }), SESSION)).toEqual([])
	expect(buildOnlyLeaks([FPC_JS], chunks({ entry: [FPC_JS] }), SESSION)).toEqual([`index.js holds ${FPC_JS}`])
	expect(buildOnlyLeaks([FPC_JS], chunks({ shared: [FPC_JS] }), SESSION)).toEqual([`shared.js holds ${FPC_JS}`])
	expect(buildOnlyLeaks([FPC_JS], chunks({ other: [FPC_JS] }), SESSION)).toEqual([`connector.js holds ${FPC_JS}`])
	// A session chunk the entry reaches statically loads with the page.
	expect(buildOnlyLeaks([FPC_JS], chunks({ session: [FPC_JS] }, true), SESSION)).toEqual([`session.js holds ${FPC_JS}`])
	const elsewhere = [join(STORE, "dest", "Token.js"), "\0/app/src/build/sponsored-fpc.ts", "/app/src/data/adapters/index.ts"]
	expect(buildOnlyLeaks(elsewhere, chunks({}), SESSION)).toEqual([`module ${elsewhere[0]}`, `module ${elsewhere[1]}`])
})

const ARTIFACT = resolveExportedAsset("@aztec-labs/noir-contracts.js", "artifacts/sponsored_fpc_contract-SponsoredFPC", {
	from: import.meta.url,
})

/** A two-module app built with the guard alone; `lazy` puts the artifact behind the session's dynamic import. */
async function guardedBuild(lazy: boolean): Promise<void> {
	const dir = scratchDir("guard-build")
	try {
		const session = join(dir, "src", "data", "adapters", "session.ts")
		mkdirSync(dirname(session), { recursive: true })
		writeFileSync(join(dir, "index.html"), '<!doctype html><script type="module" src="/src/main.ts"></script>')
		writeFileSync(session, `import a from ${JSON.stringify(ARTIFACT)}\nexport const name = a.name\n`)
		const main = lazy
			? 'import("./data/adapters/session.ts").then((m) => console.log(m.name))'
			: `import a from ${JSON.stringify(ARTIFACT)}\nconsole.log(a.name)`
		writeFileSync(join(dir, "src", "main.ts"), `${main}\n`)
		await build({
			configFile: false,
			root: dir,
			logLevel: "silent",
			build: { outDir: join(dir, "dist") },
			plugins: [stackBuildGuard(dir)],
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test("a real build fails when the page's entry imports the SponsoredFPC artifact, and passes when only the session does", async () => {
	await expect(guardedBuild(false)).rejects.toThrow(
		/build-time-only code:[\s\S]*index-[\w-]+\.js holds .*sponsored_fpc_contract-SponsoredFPC\.json/,
	)
	await expect(guardedBuild(true)).resolves.toBeUndefined()
}, 60_000)

type Hook = ((...args: unknown[]) => unknown) | { handler: (...args: unknown[]) => unknown } | undefined

/** Calls a plugin hook the way the bundler does, with `ctx` as its `this`. */
function run(hook: unknown, ctx: object, ...args: unknown[]): unknown {
	const h = hook as Hook
	if (h === undefined) throw new Error("the plugin has no such hook")
	return (typeof h === "function" ? h : h.handler).apply(ctx, args)
}

test("a stack build fails when a file copied beside the bundle (as from public/) names the fixture marker", () => {
	const dir = scratchDir("guard-output")
	try {
		const html = "<!doctype html>"
		mkdirSync(join(dir, "assets"))
		writeFileSync(join(dir, "index.html"), html)
		writeFileSync(join(dir, "assets", "copied.txt"), "window.__ppFixtures = 1")
		const guard = stackBuildGuard("/app")
		const ctx = {
			getModuleIds: () => [join("/app", "src", "main.tsx")][Symbol.iterator](),
			error: (message: string): never => {
				throw new Error(message)
			},
		}
		run(guard.configResolved, ctx, { root: "/app", build: { outDir: dir }, logger: { info() {} } })
		// The bundle holds only the page; the copied file exists on disk alone, as Vite's public copy leaves it.
		const bundle = { "index.html": { type: "asset", fileName: "index.html", source: html } }
		run(guard.generateBundle, ctx, {}, bundle)
		expect(() => run(guard.writeBundle, ctx, { dir }, bundle)).toThrow("assets/copied.txt names __ppFixtures")
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
