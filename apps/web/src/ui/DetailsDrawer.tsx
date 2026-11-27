import { Dialog } from "radix-ui"
import type { ReactNode } from "react"
import { ActionButton } from "./ActionButton"
import { DESCRIPTION, OVERLAY, TITLE } from "./dialog"

interface Props {
	title: string
	description: string
	/** Renders its own trigger button; omit it to drive the drawer with `open` alone. */
	triggerLabel?: string
	open?: boolean
	onOpenChange?(open: boolean): void
	children: ReactNode
}

/** A modal side sheet from the right: focus is trapped inside, Escape and the overlay close it. */
export function DetailsDrawer({ title, description, triggerLabel, open, onOpenChange, children }: Props) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			{triggerLabel ? (
				<Dialog.Trigger asChild>
					<ActionButton>{triggerLabel}</ActionButton>
				</Dialog.Trigger>
			) : null}
			<Dialog.Portal>
				<Dialog.Overlay className={OVERLAY} />
				<Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100vw)] animate-sheet-in flex-col gap-4 overflow-y-auto border-l border-edge bg-surface p-5 shadow-(--shadow-glass) motion-reduce:animate-none">
					<header className="flex items-start justify-between gap-3">
						<div>
							<Dialog.Title className={TITLE}>{title}</Dialog.Title>
							<Dialog.Description className={DESCRIPTION}>{description}</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<ActionButton>Close</ActionButton>
						</Dialog.Close>
					</header>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
