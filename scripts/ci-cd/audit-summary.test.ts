import { expect, test } from "bun:test"
import { type AuditReport, directDependencies, renderSummary } from "./audit-summary"

const advisory = (severity: string, vulnerable_versions: string, title: string) => ({
	severity,
	vulnerable_versions,
	title,
	url: `https://github.com/advisories/${title}`,
})

test("the summary lists our own exposed copies first, then the rest by severity", () => {
	const report: AuditReport = {
		axios: [advisory("high", "<1.20.0", "GHSA-axios")],
		vite: [advisory("low", "<=8.2.3", "GHSA-vite")],
		zod: [advisory("high", "<4.6.6", "GHSA-zod")],
		ws: [advisory("moderate", "<8.18.0", "GHSA-ws")],
	}
	const declared = new Map([
		["vite", [{ workspace: "@pp/e2e-kit", version: "8.2.1" }]],
		// Our copy is fixed; the flagged one belongs to a dependency.
		["zod", [{ workspace: "@pp/bridge-core", version: "4.6.7" }]],
	])
	const rows = renderSummary(report, declared, 1)
		.split("\n")
		.filter((l) => l.startsWith("| ") && !l.startsWith("| severity"))
	expect(rows.map((r) => r.split(" | ").slice(0, 4).join(" | "))).toEqual([
		"| low | `vite` | `<=8.2.3` | @pp/e2e-kit",
		"| high | `axios` | `<1.20.0` | transitive",
		"| high | `zod` | `<4.6.6` | transitive",
		"| moderate | `ws` | `<8.18.0` | transitive",
	])
	expect(renderSummary(report, declared, 1)).toContain("4 findings: 2 high, 1 moderate, 1 low.")
	expect(renderSummary({}, declared, 0)).toContain("No known vulnerabilities.")
})

test("the root manifest's own dependencies count as declared", () => {
	expect(directDependencies().get("@commitlint/cli")?.map((d) => d.workspace)).toContain("root")
})
