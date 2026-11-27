import { tv } from "tailwind-variants/lite"

export type StepStatus = "done" | "current" | "failed" | "todo"

export interface Step {
	key: string
	name: string
	status: StepStatus
	/** A time or short note under the name; each status has a default. */
	meta?: string
}

const item = tv({
	slots: {
		root: "relative grid grid-cols-[26px_1fr_auto] items-center gap-2.5 py-1.5 text-ui @3xl:flex-1 @3xl:grid-cols-1 @3xl:justify-items-center @3xl:gap-1.5 @3xl:py-0 @3xl:text-center @3xl:after:absolute @3xl:after:top-3 @3xl:after:right-[calc(-50%+18px)] @3xl:after:left-[calc(50%+18px)] @3xl:after:h-0.5 @3xl:after:bg-track @3xl:last:after:hidden",
		marker: "grid size-6 place-items-center rounded-full border-[1.5px] text-cap font-bold",
		name: "font-semibold",
		meta: "font-mono text-[11.5px] leading-none text-ink-3",
	},
	variants: {
		status: {
			done: { root: "@3xl:after:bg-tone-ok", marker: "border-transparent bg-tone-ok-bg text-tone-ok" },
			current: { marker: "border-tone-wait bg-glass-2 text-tone-wait ring-4 ring-tone-wait-bg", meta: "text-tone-wait" },
			failed: { marker: "border-transparent bg-tone-bad-bg text-tone-bad", meta: "text-tone-bad" },
			todo: { marker: "border-track bg-glass-2 text-ink-3", name: "text-ink-3" },
		},
	},
})

const DEFAULT_META: Record<StepStatus, string> = { done: "done", current: "in progress", failed: "failed", todo: "next" }
const SPOKEN: Record<StepStatus, string> = { done: "Done: ", current: "", failed: "Failed: ", todo: "" }

function StepItem({ step, index }: { step: Step; index: number }) {
	const s = item({ status: step.status })
	const mark = step.status === "done" ? "✓" : step.status === "failed" ? "!" : String(index + 1)
	return (
		<li className={s.root()} aria-current={step.status === "current" ? "step" : undefined} data-status={step.status}>
			<span className={s.marker()} aria-hidden="true">
				{mark}
			</span>
			<span className={s.name()}>
				<span className="sr-only">{SPOKEN[step.status]}</span>
				{step.name}
			</span>
			<span className={s.meta()}>{step.meta ?? DEFAULT_META[step.status]}</span>
		</li>
	)
}

/** Steps in order; one column when narrow, a row from 48rem. At most one step should be current. */
export function Stepper({ steps, label }: { steps: readonly Step[]; label: string }) {
	return (
		<div className="@container">
			<ol aria-label={label} className="grid @3xl:flex">
				{steps.map((step, i) => (
					<StepItem key={step.key} step={step} index={i} />
				))}
			</ol>
		</div>
	)
}
