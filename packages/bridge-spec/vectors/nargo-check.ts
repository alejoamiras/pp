/**
 * Runs keystone once and requires, by name, every legacy keystone test, the v1 section tests listed
 * here by hand with the row counts their generated tables must have, a passing `should_fail_with`
 * test for each Noir rejection (covering the codes listed here) and every name in v1.json's
 * `noirTests`. No other `v1_` test may run and nothing may fail.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AZTEC_DIR, nargoTest } from "./nargo"

const LEGACY_TESTS = [
	"mint_to_public_matches_l1",
	"mint_to_private_matches_l1",
	"withdraw_matches_l1",
	"claim_secret_dom_sep_is_pinned",
	"claim_secret_vectors_match_ts",
	"claim_secret_hash_vectors_match_ts",
	"fuzz_derive_changes_with_salt",
	"fuzz_derive_changes_with_recipient",
	"register_matches_l1_and_ts",
	"register_secret_hash_is_pinned",
]
/** Rows each generated table must hold; `v1_tags` asserts the three tags Noir holds. */
const NOIR_ROWS: Record<string, number> = {
	v1_in: 73,
	v1_out: 69,
	v1_ragequit: 71,
	v1_hash1: 20,
	v1_hash2: 19,
	v1_commitment: 17,
	v1_asp_leaf: 17,
	v1_lean_imt: 31,
	v1_claim_secret_hash: 8,
	v1_birth: 12,
}
const SECTION_TESTS = ["v1_tags", ...Object.keys(NOIR_ROWS)]
const NOIR_REJECTION_CODES = [
	"AmountOutOfRange",
	"ZeroPayee",
	"PayeeOutOfRange",
	"LabelOutOfRange",
	"DepthOutOfRange",
	"IndexOutOfRange",
	"SiblingOutOfRange",
	"ZeroRoot",
	"NotMember",
]
const MIN_REJECTION_TESTS = 13

type Rejection = { name: string; langs: string[]; error: string }
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./v1.json", import.meta.url)), "utf8")) as {
	noirTests: string[]
	rejections: Rejection[]
}

function main(): number {
	const run = nargoTest(join(AZTEC_DIR, "keystone"))
	if (run.error) {
		console.error(run.error)
		return 1
	}
	const status = new Map(run.tests.map((t) => [t.name, t.event]))
	const problems = [
		...run.tests.filter((t) => t.event !== "ok").map((t) => `${t.name}: ${t.event}\n${t.message}`),
		...requirementProblems(status),
		...rowProblems(readFileSync(join(AZTEC_DIR, "keystone", "src", "vectors_v1.nr"), "utf8")),
	]
	if (run.exitCode !== 0 || run.failed !== 0 || run.passed === 0) {
		problems.push(`suite: exit ${run.exitCode}, ${run.passed} passed, ${run.failed} failed`)
	}
	for (const p of problems) console.error(p)
	console.log(problems.length === 0 ? `keystone: ${run.passed} passed, every v1 test required by name passed` : "nargo check failed")
	return problems.length === 0 ? 0 : 1
}

function requirementProblems(status: Map<string, string>): string[] {
	const problems: string[] = []
	const rejectionTests = vectors.rejections.flatMap((r, i) =>
		r.langs.includes("nr") ? [{ test: `v1_rejection_${String(i).padStart(2, "0")}_${r.name}`, code: r.error }] : [],
	)
	const required = new Set([...LEGACY_TESTS, ...SECTION_TESTS, ...vectors.noirTests, ...rejectionTests.map((r) => r.test)])
	for (const name of required) if (status.get(name) !== "ok") problems.push(`${name}: ${status.get(name) ?? "did not run"}`)
	for (const name of status.keys()) if (name.startsWith("v1_") && !required.has(name)) problems.push(`${name}: unexpected v1 test`)
	const codes = new Set(rejectionTests.filter((r) => status.get(r.test) === "ok").map((r) => r.code))
	for (const code of NOIR_REJECTION_CODES) if (!codes.has(code)) problems.push(`no passing Noir rejection test for ${code}`)
	if (rejectionTests.length < MIN_REJECTION_TESTS) {
		problems.push(`${rejectionTests.length} Noir rejection tests, floor ${MIN_REJECTION_TESTS}`)
	}
	return problems
}

/** A renderer that drops a row keeps every test green, so the table sizes are checked here. */
function rowProblems(source: string): string[] {
	const problems = Object.entries(NOIR_ROWS).flatMap(([test, rows]) => {
		const start = source.indexOf(`fn ${test}() {`)
		const body = start < 0 ? "" : source.slice(start, source.indexOf("\n}\n", start))
		const size = /let cases: \[[^\n]*; (\d+)\] = \[/.exec(body)?.[1]
		const loops = body.match(/for i in 0\.\.[^ ]+ \{/g) ?? []
		return [
			...(Number(size) === rows ? [] : [`${test}: table holds ${size ?? "no"} rows, expected ${rows}`]),
			// A literal bound below the table size would skip rows and still pass.
			...(loops.length === 1 && loops[0] === "for i in 0..cases.len() {"
				? []
				: [`${test}: loop must be \`for i in 0..cases.len()\``]),
		]
	})
	const tags = /fn v1_tags\(\) \{([^}]*)\}/.exec(source)?.[1] ?? ""
	if ((tags.match(/assert\(PP_BRIDGE_/g) ?? []).length !== 3) problems.push("v1_tags: expected three tag assertions")
	return problems
}

process.exit(main())
