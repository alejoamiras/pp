// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ActionButton, Amount, LabelChip, StateBadge, type Step, Stepper } from "."

afterEach(cleanup)

describe("ui", () => {
	it("StateBadge says its state in words in every tone", () => {
		const tones = ["ok", "wait", "attn", "bad", "neutral"] as const
		render(
			<div>
				{tones.map((t) => (
					<StateBadge key={t} tone={t}>{`state ${t}`}</StateBadge>
				))}
			</div>,
		)
		for (const t of tones) expect(screen.getByText(`state ${t}`).dataset.tone).toBe(t)
	})

	it("LabelChip draws the same glyph for the same label and another for another label", () => {
		const glyph = (label: bigint) => render(<LabelChip label={label} />).container.querySelector("svg")?.innerHTML
		const first = glyph(0x2f9cn)
		expect(first).toContain("<rect")
		expect(glyph(0x2f9cn)).toBe(first)
		expect(glyph(0x8b1dn)).not.toBe(first)
	})

	it("Stepper marks only the current step with aria-current", () => {
		const steps: Step[] = [
			{ key: "a", name: "Prepared", status: "done" },
			{ key: "b", name: "Mined", status: "done" },
			{ key: "c", name: "Claimable", status: "current" },
			{ key: "d", name: "Claimed", status: "todo" },
		]
		const { container } = render(<Stepper steps={steps} label="Bridge steps" />)
		const current = container.querySelectorAll('[aria-current="step"]')
		expect(current).toHaveLength(1)
		expect(current[0]?.textContent).toContain("Claimable")
	})

	it("a disabled ActionButton shows its reason as text tied to the button", () => {
		render(<ActionButton disabledReason="Send opens once the label is approved">Send privately</ActionButton>)
		const button = screen.getByRole<HTMLButtonElement>("button", { name: "Send privately" })
		expect(button.disabled).toBe(true)
		expect(button.getAttribute("aria-describedby")).toBe(screen.getByText("Send opens once the label is approved").id)
	})

	it("Amount never shows a tiny non-zero value as 0", () => {
		const { container } = render(<Amount value={1n} decimals={18} symbol="USDC" />)
		const shown = (container.textContent ?? "").replace("USDC", "")
		expect(shown).toBe("0.000000000000000001")
		expect(Number(shown)).toBeGreaterThan(0)
	})
})
