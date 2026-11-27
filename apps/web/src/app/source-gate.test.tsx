// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test } from "vitest"
import { BridgeFailure, messageOf } from "../data/errors"
import { createFixtureSource } from "../data/fixtures"
import type { DataSource } from "../data/source"
import { SourceGate } from "./SourceGate"

afterEach(cleanup)

test("a failed deployment read says why and renders nothing else; reading again opens the app", async () => {
	const { source } = createFixtureSource(null)
	const answers: (() => Promise<DataSource>)[] = [() => Promise.reject(new BridgeFailure("DEPLOYMENT_MISMATCH")), async () => source]
	render(<SourceGate load={() => (answers.shift() as () => Promise<DataSource>)()} />)
	await screen.findByText(messageOf("DEPLOYMENT_MISMATCH"))
	expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull()
	await userEvent.setup().click(screen.getByRole("button", { name: "Read it again" }))
	await screen.findByRole("button", { name: /Sign in/ })
})
