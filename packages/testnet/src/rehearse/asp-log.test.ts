import { expect, it } from "vitest"
import { aspLines, type Mark } from "./asp-log"
import type { Recorded } from "./recorder"

const OWNER = "0x32f984A9561635dAb2AD48881FDd8E4782Da82D5"
const POSTER = "0x1924ff866e94ef8e308b409f180fd3e644113ffe2b86d18ff446cb093e5c9635"
const ENTRYPOINT = "0xDaFf8Fab148132623ebe0E107837d3850e3aD7FC"

const request = (path: string, query: Record<string, string>, headers: Record<string, string> = {}): Recorded => ({
	method: "GET",
	path,
	query,
	headers: { "user-agent": "Bun/1.4.2", ...headers },
	bodyBytes: 0,
	status: 200,
})

it("names each account a request carries, in its path, query or headers, under its step", () => {
	const named = { event: "addresses", CANARY_OWNER_KEY: OWNER, BOT_POSTER_SECRET: POSTER }
	const marks: Mark[] = [
		["bot 1", 0],
		["canary", 1],
	]
	const lines = aspLines(
		"stack",
		[
			request("/association-set/leaves", { chainId: "31337", entrypoint: ENTRYPOINT }),
			request(`/public/deposits/${OWNER.toLowerCase()}`, {}),
			request("/association-set/leaves", { chainId: "31337" }, { "x-trace": POSTER.slice(2).toUpperCase() }),
		],
		marks,
		named,
	)
	expect(lines.map((l) => l.carried)).toEqual([[], ["CANARY_OWNER_KEY"], ["BOT_POSTER_SECRET"]])
	expect(lines[0]?.line).toBe(
		`[stack] asp bot 1: GET /association-set/leaves?chainId=31337&entrypoint=${ENTRYPOINT} (Bun/1.4.2) -> 200; carries no named account`,
	)
	expect(lines[2]?.line).toMatch(/^\[stack\] asp canary: .* carries BOT_POSTER_SECRET$/)
})
