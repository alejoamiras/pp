import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "test/browser",
	globalSetup: "./test/browser/global-setup.ts",
	timeout: 180_000,
	workers: 1,
	reporter: "list",
	use: { browserName: "chromium", headless: true },
	projects: [
		{ name: "offline", testMatch: /prove\.spec\.ts/ },
		{ name: "spend", testMatch: /spend\.spec\.ts/ },
	],
})
