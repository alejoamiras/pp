/**
 * One config for every mode. `vite build` and `vite` read the kit's committed placeholder handle and
 * use the fixture connector; `vite build --mode sandbox` (`build:local`; Vite reserves the mode name
 * `local`) uses the real one with the wallets in `PP_WEB_WALLETS`, and reads either a stack manifest
 * (`PP_STACK_MANIFEST`: `#data` points at the adapters and the fixture guard is armed) or a sandbox
 * run (`PP_SANDBOX_ARTIFACTS`: the fixture world). `vite preview` reads no target: the kit starts it
 * with no `--config` and only `PP_SANDBOX_ARTIFACTS`, and the headers come from the build's own
 * `security-headers.json`.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type UserConfig } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { ISOLATION_HEADERS } from "./src/build/headers.ts"
import { bufferSubpathAlias, emitSecurityHeaders, previewSecurityHeaders, stackBuildGuard } from "./src/build/plugins.ts"
import { sponsoredFpcAddress } from "./src/build/sponsored-fpc.ts"
import { demoSenderModule, parseDataMode, resolveTarget } from "./src/build/target.ts"

const root = dirname(fileURLToPath(import.meta.url))

/** Build-time values a stack target needs; only addresses leave this process, and only for stack builds. */
async function stackDerivations(): Promise<{ sponsoredFpc: string; demoSender: string }> {
	const [sponsoredFpc, { DEMO_SENDER_ADDRESS }] = await Promise.all([sponsoredFpcAddress(), import("@pp/local-stack/seed")])
	return { sponsoredFpc, demoSender: DEMO_SENDER_ADDRESS }
}

/** `font-src 'self'` refuses `data:` fonts, and small subsets fall under the default inline limit. */
const FONT_FILE = /\.(woff2?|ttf|otf)$/

export default defineConfig(async ({ mode, isPreview }): Promise<UserConfig> => {
	if (isPreview) return { root, plugins: [previewSecurityHeaders()] }
	const target = resolveTarget({
		local: mode === "sandbox",
		env: process.env,
		committedHandle: resolvePackageAsset("@pp/e2e-kit", "fixtures/build-artifacts/handle.json", { from: import.meta.url }),
		...(parseDataMode(process.env) === "stack" ? await stackDerivations() : {}),
	})
	const bufferShim = resolvePackageAsset("vite-plugin-node-polyfills", "shims/buffer/dist/index.js", { from: import.meta.url })
	return {
		root,
		server: { headers: { ...ISOLATION_HEADERS } },
		build: {
			outDir: "dist",
			// The kit's `--outDir` lies outside the root, where Vite would otherwise leave stale files.
			emptyOutDir: true,
			sourcemap: false,
			target: "esnext",
			assetsInlineLimit: (file) => (FONT_FILE.test(file) ? false : undefined),
		},
		define: {
			__PP_TARGET__: JSON.stringify(target),
			__PP_CONNECTOR__: JSON.stringify(target.connector),
		},
		resolve: {
			alias: [
				{
					find: /^#data$/,
					replacement: join(root, "src", "data", target.dataMode === "stack" ? "adapters" : "fixtures", "index.ts"),
				},
				{ find: /^#demo-sender$/, replacement: join(root, "src", "data", "adapters", demoSenderModule(target)) },
				// nodePolyfills injects this shim into every transformed module, dependencies included, and
				// the isolated linker lets a dependency resolve only what it declares: pin this app's copy.
				{ find: "vite-plugin-node-polyfills/shims/buffer", replacement: bufferShim },
			],
			// Two copies of a wasm binding split its init and its calls across module scopes.
			dedupe: ["@aztec-foundation/noir-noirc_abi", "@aztec-foundation/noir-acvm_js"],
		},
		optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@aztec-foundation/noir-acvm_js", "@aztec-foundation/noir-noirc_abi"] },
		worker: { format: "es" },
		plugins: [
			react(),
			tailwindcss(),
			// `fs` stays with Vite's browser stub, which also answers `fs/promises` and its named imports; the
			// plugin's prefix alias would point that subpath inside its one-export empty mock.
			nodePolyfills({ exclude: ["fs"], globals: { Buffer: true, global: true, process: true } }),
			bufferSubpathAlias(bufferShim),
			emitSecurityHeaders(target),
			...(target.dataMode === "stack" ? [stackBuildGuard(root)] : []),
		],
	}
})
