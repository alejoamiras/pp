// Node only, apart from the send path's entry, so a dependent without Node's types can import that.
import { appendFileSync } from "node:fs"
import type { JournalEntry } from "./send-path.ts"

/** A journal that appends each entry as a JSON line to `path`, readable by this user only. */
export const journalTo =
	(path: string) =>
	(entry: JournalEntry): void =>
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
