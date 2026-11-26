import { tv } from "tailwind-variants/lite"

/** What a state asks of the reader. The tone always travels with words; colour alone never carries it. */
export type Tone = "ok" | "wait" | "attn" | "bad" | "neutral"

/**
 * One recipe for every toned element (badge, step marker, callout), so a state reads the same
 * everywhere. Each ink/ground pair is a row in contrast.test.ts.
 */
export const tone = tv({
	slots: { ground: "", ink: "", border: "" },
	variants: {
		tone: {
			ok: { ground: "bg-tone-ok-bg", ink: "text-tone-ok", border: "border-tone-ok/30" },
			wait: { ground: "bg-tone-wait-bg", ink: "text-tone-wait", border: "border-tone-wait/30" },
			attn: { ground: "bg-tone-attn-bg", ink: "text-tone-attn", border: "border-tone-attn/30" },
			bad: { ground: "bg-tone-bad-bg", ink: "text-tone-bad", border: "border-tone-bad/30" },
			neutral: { ground: "bg-glass-2", ink: "text-ink-2", border: "border-edge" },
		},
	},
})
