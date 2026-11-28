import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { onTestFinished } from "vitest"
import { keyFilePath } from "./keyfile"

/** A scratch home under `~/.cache/pp/`, removed when the test finishes; never the account's key file. */
export function scratchHome(): string {
	const parent = join(homedir(), ".cache", "pp", "testnet-tests")
	mkdirSync(parent, { recursive: true })
	const home = mkdtempSync(join(parent, "home-"))
	onTestFinished(() => rmSync(home, { recursive: true, force: true }))
	return home
}

/** Writes `lines` as `home`'s key file with the given modes and returns its path. */
export function writeKeyFile(home: string, lines: readonly string[], modes = { dir: 0o700, file: 0o600 }): string {
	const path = keyFilePath(home)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	chmodSync(dirname(path), modes.dir)
	writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 })
	chmodSync(path, modes.file)
	return path
}
