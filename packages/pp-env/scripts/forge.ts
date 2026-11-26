#!/usr/bin/env bun
// Runs the repository's pinned forge with the caller's arguments.
import { forgeBin } from "../src/env/tools.ts"

const proc = Bun.spawn([forgeBin(), ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] })
process.exit(await proc.exited)
