#!/usr/bin/env bun
/**
 * `bun scripts/check-cases.ts <group> <vitest-json-report>…`: fails unless every case id of the
 * group passed in the reports. A case is a test whose name starts with its id and a space; a skipped,
 * todo or filtered case is a gate that never ran, so it fails like a broken one.
 */
import { readFileSync } from "node:fs"

/** The named cases each gate must run; a list only grows as its phases land. */
export const CASE_GROUPS = {
	deploy: ["D0", "D1a", "D1b"],
	/** The whole stack suite, with the three cases that run at the unit layer (S6u, S7u, E1u). */
	bridge: [
		"D0",
		"D1a",
		"D1b",
		"B1",
		"B2",
		"B3",
		"S1",
		"S2",
		"S2b",
		"S3",
		"S4",
		"S5",
		"S6u",
		"S7",
		"S7u",
		"J1",
		"J2",
		"J3",
		"P1",
		"E1",
		"E1u",
		"E2",
		"E3",
		"X1",
		"X2",
		"BT1",
	],
	"local-stack": ["L1"],
} as const satisfies Record<string, readonly string[]>

export type CaseGroup = keyof typeof CASE_GROUPS

type Assertion = { title: string; status: string }
type Report = { testResults: { assertionResults: Assertion[] }[] }

/** Each required id that did not pass exactly as named, with the reason. */
export function missingCases(required: readonly string[], reports: readonly Report[]): string[] {
	const results = reports.flatMap((r) => r.testResults.flatMap((t) => t.assertionResults))
	return required.flatMap((id) => {
		const named = results.filter((a) => a.title.startsWith(`${id} `))
		if (named.length === 0) return [`${id}: not run`]
		const bad = named.filter((a) => a.status !== "passed")
		return bad.length ? [`${id}: ${bad.map((a) => a.status).join(", ")}`] : []
	})
}

if (import.meta.main) {
	const [group, ...paths] = process.argv.slice(2)
	if (!group || !(group in CASE_GROUPS) || paths.length === 0) {
		console.error(`usage: bun scripts/check-cases.ts <${Object.keys(CASE_GROUPS).join("|")}> <report.json>…`)
		process.exit(2)
	}
	const reports = paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as Report)
	const missing = missingCases(CASE_GROUPS[group as CaseGroup], reports)
	if (missing.length) {
		console.error(`[check-cases] ${group}: ${missing.join("; ")}`)
		process.exit(1)
	}
	console.log(`[check-cases] ${group}: ${CASE_GROUPS[group as CaseGroup].join(", ")} passed`)
}
