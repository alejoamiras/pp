import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createPublicClient, http } from "viem"
import { inject } from "vitest"
import { parseStackManifest, requireBlocks } from "../../../../src/stack-manifest"

/** The attached stack's manifest; global setup has already checked it is live. */
export const attached = () => requireBlocks(parseStackManifest(JSON.parse(readFileSync(inject("manifestPath"), "utf8"))), ["bridge"])

export type AttachedStack = ReturnType<typeof attached>

export const l1Client = (m: AttachedStack) => createPublicClient({ transport: http(m.l1Rpc) })

/** A directory on real disk for one case's PXE and journal, removed by the returned function. */
export function scratch(name: string): { path: string; remove(): void } {
	const path = join(homedir(), ".cache", "pp", "bridge-stack-tests", `${name}-${process.pid}-${Date.now()}`)
	mkdirSync(path, { recursive: true })
	return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}
