/**
 * Writes `vectors/v1.json` and the keystone's `src/vectors_v1.nr` from one corpus, or with `--check`
 * exits 1 unless both files already equal what it would write, byte for byte.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildCorpus } from "./corpus"
import { noirTestNames, renderNoir } from "./render-nr"

const JSON_PATH = fileURLToPath(new URL("./v1.json", import.meta.url))
const NR_PATH = fileURLToPath(new URL("../../../contracts/bridge/aztec/keystone/src/vectors_v1.nr", import.meta.url))

async function main(check: boolean): Promise<number> {
	const corpus = await buildCorpus(noirTestNames)
	const { counts, noirTests, ...sections } = corpus
	const outputs: [string, string][] = [
		[JSON_PATH, `${JSON.stringify({ version: 1, ...sections, counts, noirTests }, null, "\t")}\n`],
		[NR_PATH, renderNoir(sections)],
	]
	if (!check) {
		for (const [path, text] of outputs) writeFileSync(path, text)
		return 0
	}
	const stale = outputs.filter(([path, text]) => {
		try {
			return readFileSync(path, "utf8") !== text
		} catch {
			return true
		}
	})
	for (const [path] of stale) console.error(`stale: ${path} (run \`bun run --cwd packages/bridge-spec vectors\`)`)
	return stale.length === 0 ? 0 : 1
}

// Barretenberg keeps worker threads alive, so the process exits explicitly.
process.exit(await main(process.argv.includes("--check")))
