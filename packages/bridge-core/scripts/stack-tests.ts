#!/usr/bin/env bun
/**
 * `bun run test:integration:stack [vitest args]`: the stack suite against the stack PP_STACK_MANIFEST
 * names (beside `bun run demo --keep`) or, when it is unset, against one `with-stack.ts` boots and
 * stops for this run. A leading `--` is dropped, as in `with-stack.ts`.
 */
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const argv = process.argv.slice(2)
const args = argv[0] === "--" ? argv.slice(1) : argv
const vitest = ["bun", "--bun", "vitest", "run", "--config", "vitest.stack.config.ts", ...args]
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`
const [cmd, ...rest] = process.env.PP_STACK_MANIFEST ? vitest : ["bun", "scripts/with-stack.ts", vitest.map(quote).join(" ")]
process.exit(spawnSync(cmd!, rest, { cwd: PKG, stdio: "inherit" }).status ?? 1)
