import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

// No plugins on purpose: the package must load in a plain production build, as an app would consume it.
export default defineConfig({
	root: fileURLToPath(new URL("./page", import.meta.url)),
	logLevel: "warn",
	build: {
		outDir: fileURLToPath(new URL("./dist", import.meta.url)),
		emptyOutDir: true,
		target: "esnext",
		chunkSizeWarningLimit: 10_000,
	},
})
