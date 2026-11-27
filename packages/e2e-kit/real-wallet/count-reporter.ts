/**
 * Prints exactly one line, `real-wallet: N/5 passed as expected`, which the nightly suite parses at
 * the same total. A test counts only when it was expected to pass and did: a skip, a `test.fail()`,
 * a flaky retry or a `--repeat-each` copy never reaches the total. The total is constant, so a run
 * of fewer tests can only print fewer.
 */
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"

export const REAL_WALLET_TESTS = 5

export default class CountReporter implements Reporter {
	private readonly passed = new Set<string>()
	private readonly failed = new Set<string>()

	onTestEnd(test: TestCase, result: TestResult): void {
		const first = result.retry === 0 && test.repeatEachIndex === 0
		if (result.status === "passed" && test.expectedStatus === "passed" && first) this.passed.add(test.id)
		else this.failed.add(test.id)
	}

	onEnd(_result: FullResult): void {
		const n = [...this.passed].filter((id) => !this.failed.has(id)).length
		console.log(`real-wallet: ${n}/${REAL_WALLET_TESTS} passed as expected`)
	}

	printsToStdio(): boolean {
		return false
	}
}
