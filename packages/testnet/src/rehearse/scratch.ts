/** A rehearsal's scratch deployment file, and the real CLI runs that read and extend it. */
import { readFileSync, writeFileSync } from "node:fs"
import { committedClassIds } from "../pins"
import { parseDeployment, serializeDeployment, type TestnetDeployment } from "../schema"
import { type CliRun, type Event, runCli } from "./runner"

export type Scratch = {
	file: string
	env: NodeJS.ProcessEnv
	/** Appended to every run: the part's `--rehearse…` flag and its value. */
	modeArgs: readonly string[]
	tag: string
	log: (line: string) => void
	/** Every run's combined output, for the check that no key value reached it. */
	outputs: string[]
}

/** Runs `name`; anything but exit 0 fails the rehearsal with the CLI's own output. */
export async function must(s: Scratch, name: string, args: readonly string[], env = s.env): Promise<Event[]> {
	const t0 = performance.now()
	const r: CliRun = await runCli(name, [...args, ...s.modeArgs], env)
	s.outputs.push(r.out)
	if (r.code !== 0) throw new Error(`${name} exited ${r.code}:\n${r.out.trim()}`)
	s.log(`[${s.tag}] ${name} ${Math.round(performance.now() - t0)} ms`)
	return r.events
}

export const writeScratch = (s: Scratch, d: TestnetDeployment) => writeFileSync(s.file, serializeDeployment(d))
export const loadScratch = (s: Scratch) => parseDeployment(JSON.parse(readFileSync(s.file, "utf8")))

/** Moves the candidate section a run named in its `event` into the scratch file. */
export function promote(s: Scratch, events: Event[], event: string): void {
	const path = events.find((e) => e.event === event)?.candidate
	if (typeof path !== "string") throw new Error(`${event} named no candidate`)
	writeScratch(s, { ...loadScratch(s), ...JSON.parse(readFileSync(path, "utf8")) })
}

export type Amounts = NonNullable<TestnetDeployment["expected"]>["amounts"]

/** `expected` from `addresses`' or `keys`' output, keyed by key name. */
export function expectedOf(a: Record<string, string>, amounts: Amounts): NonNullable<TestnetDeployment["expected"]> {
	const at = (name: string) => a[name] as `0x${string}`
	return {
		guardian: at("GUARDIAN_KEY"),
		lifetimeCap: 1_000_000_000_000n,
		l1Deployer: at("L1_DEPLOYER_KEY"),
		l2Deployer: at("L2_DEPLOYER_SECRET"),
		botPoster: at("BOT_POSTER_SECRET"),
		aspPostman: at("ASP_POSTMAN_KEY"),
		poolDeployer: at("POOL_DEPLOYER_KEY"),
		canaryOwner: at("CANARY_OWNER_KEY"),
		canarySender: at("CANARY_SENDER_KEY"),
		...(a.DEMO_OWNER_KEY !== undefined && { demoOwner: at("DEMO_OWNER_KEY") }),
		...(a.DEMO_SENDER_KEY !== undefined && { demoSender: at("DEMO_SENDER_KEY") }),
		birthIntake: at("BOT_INTAKE_SECRET"),
		tokenClassId: committedClassIds().labelledToken as `0x${string}`,
		amounts,
	}
}

/**
 * Throws when any output holds a key value, with or without its 0x prefix and in any case. The CLIs
 * already scrub what they print; this checks the scrub from outside.
 */
export function assertNoKeyIn(outputs: readonly string[], keys: readonly string[]): void {
	const text = outputs.join("\n").toLowerCase()
	const leaked = keys.findIndex((k) => text.includes(k.toLowerCase().replace(/^0x/, "")))
	if (leaked >= 0) throw new Error(`a CLI printed key ${leaked + 1} of ${keys.length}`)
}
