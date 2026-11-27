// keys
// Creates `~/.config/pp/testnet.env` (directory 0700, file 0600) if absent and appends a key for every
// name it lacks, generated in this process. A name already in the file is never rewritten. Prints each
// name's public address and whether this run created it; no value is ever printed.
import { constants, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { addressesOf } from "../accounts"
import { GuardError } from "../guards"
import { appendKeyLines, assertKeyDir, generateKey, isKeyValue, KEY_NAMES, keyFilePath, openKeyFile, parseKeyLines } from "../keyfile"
import { remember } from "../redact"
import { main, report } from "./common"

const exists = (path: string) => {
	try {
		lstatSync(path)
		return true
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false
		throw e
	}
}

await main(async () => {
	if (process.argv.length > 2) throw new GuardError("argv", "keys takes no arguments")
	const uid = process.getuid?.() ?? -1
	const path = keyFilePath()
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	assertKeyDir(dirname(path), uid)
	const flags = constants.O_RDWR | constants.O_APPEND | (exists(path) ? 0 : constants.O_CREAT | constants.O_EXCL)
	const fd = openKeyFile(path, flags, uid)
	const text = readFileSync(fd, "utf8")
	const { names, values } = parseKeyLines(text, path, new Set(KEY_NAMES.map((k) => k.name)))
	for (const { name, kind } of KEY_NAMES) {
		const v = values.get(name)
		if (v !== undefined && !isKeyValue(kind, v))
			throw new GuardError("keys", `${name} in ${path} is not a valid ${kind} key; fix or remove that line`)
	}
	const created = KEY_NAMES.filter((k) => !names.includes(k.name))
	for (const { name, kind } of created) values.set(name, generateKey(kind))
	remember(values.values())
	appendKeyLines(
		fd,
		text,
		created.map(({ name }) => `${name}=${values.get(name)}`),
	)
	const addresses = await addressesOf(KEY_NAMES, Object.fromEntries(values) as Record<string, `0x${string}`>)
	for (const { name } of KEY_NAMES)
		report("key", { name, address: addresses[name] as string, created: created.some((k) => k.name === name) })
	return 0
})
