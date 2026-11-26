#!/usr/bin/env bun
// The only networked step: fetch and build Privacy Pools v2 at the pinned commit, link it as .ppv2,
// install the pool's solc, and build our fixture contracts, which may download theirs. Everything
// after this runs offline.
import { rename, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CHECKOUT_LINK } from "../src/env/checkout.ts"
import { buildFixtures } from "../src/env/deploy.ts"
import { fetchPpv2 } from "../src/env/fetch/index.ts"
import { CONTRACTS_DIR } from "../src/env/pins.ts"
import { installConfiguredSolc } from "../src/env/tools.ts"

const t0 = performance.now()
const { target, fetched } = await fetchPpv2((line) => console.log(line))
const tmp = `${CHECKOUT_LINK}.${process.pid}`
await unlink(tmp).catch(() => {})
await symlink(join(target, "src"), tmp)
await rename(tmp, CHECKOUT_LINK)
console.log(`solc ${await installConfiguredSolc(join(target, "src", CONTRACTS_DIR))}: installed`)
await buildFixtures(false)
console.log(`${fetched ? "fetched" : "ready"}: ${target} (${Math.round(performance.now() - t0)} ms)`)
