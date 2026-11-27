import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base.ts"
import type { PublicTarget } from "./src/build/target.ts"

const root = fileURLToPath(new URL(".", import.meta.url))

const TEST_TARGET: PublicTarget = {
	nodeUrl: "http://127.0.0.1:8080",
	l1RpcUrl: "http://127.0.0.1:8545",
	l1ChainId: 31337,
	rollupVersion: 1,
	walletUrls: [],
	dataMode: "fixtures",
	connector: "fixture",
	stack: null,
}

export default defineConfig({
	define: {
		__PP_TARGET__: JSON.stringify(TEST_TARGET),
		__PP_CONNECTOR__: JSON.stringify(TEST_TARGET.connector),
	},
	resolve: {
		alias: [
			{ find: /^#data$/, replacement: join(root, "src", "data", "fixtures", "index.ts") },
			{ find: /^#demo-sender$/, replacement: join(root, "src", "data", "adapters", "demo-sender.ts") },
		],
	},
	test: {
		...sharedTest,
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
	},
})
