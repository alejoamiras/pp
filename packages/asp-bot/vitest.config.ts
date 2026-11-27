import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({ test: { ...sharedTest, environment: "node", exclude: ["test/integration/**", "**/node_modules/**"] } })
