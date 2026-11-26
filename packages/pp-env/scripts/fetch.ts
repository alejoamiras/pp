#!/usr/bin/env bun
// The only networked step: fetch and build Privacy Pools v2 at the pinned commit, then link it as .ppv2.
import { rename, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CHECKOUT_LINK } from "../src/env/checkout.ts"
import { fetchPpv2 } from "../src/env/fetch/index.ts"

const t0 = performance.now()
const { target, fetched } = await fetchPpv2((line) => console.log(line))
const tmp = `${CHECKOUT_LINK}.${process.pid}`
await unlink(tmp).catch(() => {})
await symlink(join(target, "src"), tmp)
await rename(tmp, CHECKOUT_LINK)
console.log(`${fetched ? "fetched" : "ready"}: ${target} (${Math.round(performance.now() - t0)} ms)`)
