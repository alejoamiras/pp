import type { FullResult, TestCase, TestResult } from "@playwright/test/reporter"
import { describe, expect, it, vi } from "vitest"
import CountReporter from "./count-reporter"

const tc = (id: string, expectedStatus: TestCase["expectedStatus"] = "passed") => ({ id, expectedStatus }) as TestCase
const res = (status: TestResult["status"], retry = 0) => ({ status, retry }) as TestResult

function printed(feed: (r: CountReporter) => void): string[] {
	const r = new CountReporter()
	const log = vi.spyOn(console, "log").mockImplementation(() => {})
	feed(r)
	r.onEnd({} as FullResult)
	const lines = log.mock.calls.map((c) => String(c[0]))
	log.mockRestore()
	return lines
}

describe("count reporter", () => {
	it("prints one line counting only tests expected to pass that passed on their first try", () => {
		const lines = printed((r) => {
			r.onTestEnd(tc("boot"), res("passed"))
			r.onTestEnd(tc("connects"), res("skipped"))
			r.onTestEnd(tc("claims"), res("failed"))
			r.onTestEnd(tc("claims"), res("passed", 1))
			r.onTestEnd(tc("marked-to-fail", "failed"), res("failed"))
		})
		expect(lines).toEqual(["real-wallet: 1/3 passed as expected"])
	})
})
