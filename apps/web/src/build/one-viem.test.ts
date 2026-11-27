import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageRoot } from "@nulo-sh/resolve-asset"
import { expect, test } from "vitest"

type Manifest = { dependencies?: Record<string, string> }

const APP = fileURLToPath(new URL("../..", import.meta.url))
const manifestOf = (root: string): Manifest => JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest
const resolveFrom = (root: string, pkg: string) => realpathSync(resolvePackageRoot(pkg, { from: join(root, "package.json") }))

/** The app and every workspace package it ships, transitively through `dependencies`, by real root. */
function shipped(): Map<string, string> {
	const roots = new Map([["@pp/web", realpathSync(APP)]])
	const queue = [...roots.values()]
	for (let root = queue.pop(); root !== undefined; root = queue.pop())
		for (const dep of Object.keys(manifestOf(root).dependencies ?? {}))
			if (dep.startsWith("@pp/") && !roots.has(dep)) {
				roots.set(dep, resolveFrom(root, dep))
				queue.push(roots.get(dep) as string)
			}
	return roots
}

// Two viem instances in one closure (the isolated linker splits one version by its peers' versions)
// make a viem error built by the page fail bridge-core's `instanceof BaseError`, so the bridge client
// misreads a wallet's rejection, and the bundle carries viem twice.
test("every package the app ships that depends on viem resolves the same viem", () => {
	const viem = new Map<string, string>()
	for (const [name, root] of shipped()) if (manifestOf(root).dependencies?.viem) viem.set(name, resolveFrom(root, "viem"))
	expect([...viem.keys()]).toEqual(expect.arrayContaining(["@pp/web", "@pp/bridge-core", "@pp/pool-client", "@pp/bridge-spec"]))
	const app = viem.get("@pp/web")
	expect(Object.fromEntries(viem)).toEqual(Object.fromEntries([...viem.keys()].map((name) => [name, app])))
})
