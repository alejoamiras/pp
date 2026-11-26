/**
 * Runs keystone once and requires every v1 Noir test to pass by name: the section tests listed here
 * by hand, a passing `should_fail_with` test for each Noir rejection (its names covering the codes
 * listed here), and every name in v1.json's `noirTests`. No other `v1_` test may run, nothing may fail.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AZTEC_DIR, nargoTest } from "./nargo"

const SECTION_TESTS = [
	"v1_tags",
	"v1_in",
	"v1_out",
	"v1_ragequit",
	"v1_hash1",
	"v1_hash2",
	"v1_commitment",
	"v1_asp_leaf",
	"v1_lean_imt",
	"v1_claim_secret_hash",
	"v1_birth",
]
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
	]
	if (run.failed !== 0 || run.passed === 0) problems.push(`suite: ${run.passed} passed, ${run.failed} failed`)
	for (const p of problems) console.error(p)
	console.log(problems.length === 0 ? `keystone: ${run.passed} passed, every v1 test required by name passed` : "nargo check failed")
	return problems.length === 0 ? 0 : 1
}

function requirementProblems(status: Map<string, string>): string[] {
	const problems: string[] = []
	const rejectionTests = vectors.rejections.flatMap((r, i) =>
		r.langs.includes("nr") ? [{ test: `v1_rejection_${String(i).padStart(2, "0")}_${r.name}`, code: r.error }] : [],
	)
	const required = new Set([...SECTION_TESTS, ...vectors.noirTests, ...rejectionTests.map((r) => r.test)])
	for (const name of required) if (status.get(name) !== "ok") problems.push(`${name}: ${status.get(name) ?? "did not run"}`)
	for (const name of status.keys()) if (name.startsWith("v1_") && !required.has(name)) problems.push(`${name}: unexpected v1 test`)
	const codes = new Set(rejectionTests.filter((r) => status.get(r.test) === "ok").map((r) => r.code))
	for (const code of NOIR_REJECTION_CODES) if (!codes.has(code)) problems.push(`no passing Noir rejection test for ${code}`)
	if (rejectionTests.length < MIN_REJECTION_TESTS) {
		problems.push(`${rejectionTests.length} Noir rejection tests, floor ${MIN_REJECTION_TESTS}`)
	}
	return problems
}

process.exit(main())
