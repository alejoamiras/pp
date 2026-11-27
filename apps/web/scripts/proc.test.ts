import { spawn } from "node:child_process"
import { once } from "node:events"
import { endGroup, groupAlive, groupGone } from "@pp/run-isolation/process-group"
import { expect, onTestFinished, test } from "vitest"

const PROC = new URL("./proc.ts", import.meta.url).href

test("a group this package starts ends when the process that started it is killed", async () => {
	const parent = spawn(
		process.execPath,
		[
			"-e",
			`const { startGroup } = await import(${JSON.stringify(PROC)}); console.log(startGroup("sleep", ["60"]).pid); setInterval(() => {}, 1000)`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	)
	onTestFinished(() => void parent.kill("SIGKILL"))
	const [line] = (await once(parent.stdout, "data")) as [Buffer]
	const pgid = Number(line.toString().trim())
	onTestFinished(async () => void (await endGroup(pgid, 1_000)))
	expect(groupAlive(pgid)).toBe(true)
	// SIGKILL: no handler of the parent's runs, as when an interrupted run is torn down hard.
	parent.kill("SIGKILL")
	expect(await groupGone(pgid, 10_000)).toBe(true)
}, 20_000)
