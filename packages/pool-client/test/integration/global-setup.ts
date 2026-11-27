import type { TestProject } from "vitest/node"
import { startEnv } from "../support/env.ts"

declare module "vitest" {
	export interface ProvidedContext {
		poolEnv: string
	}
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const running = await startEnv()
	project.provide("poolEnv", JSON.stringify(running.env))
	return () => running.stop()
}
