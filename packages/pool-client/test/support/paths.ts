import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkout } from "../../../pp-env/src/env/checkout.ts"

export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..")

/** The pinned checkout's circuit builds; throws, naming the fetch command, when pp-env has not fetched. */
export function circuitsDir(): string {
	return checkout().circuits
}

/** A per-run scratch directory on real disk, removed by the returned function. */
export function scratchDir(name: string): { path: string; remove(): void } {
	const path = join(homedir(), ".cache/pp/pool-client", `${name}-${process.pid}-${Date.now()}`)
	mkdirSync(path, { recursive: true })
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}
