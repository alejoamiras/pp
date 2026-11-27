import { Dialog } from "radix-ui"
import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { DESCRIPTION, OVERLAY, TITLE } from "./dialog"

type Props = Omit<ComponentPropsWithoutRef<"div">, "title" | "className" | "children"> & {
	open: boolean
	onOpenChange(open: boolean): void
	title: string
	description: string
	children: ReactNode
}

/** A centred modal dialog; other attributes (test ids, data-*) land on the dialog element. */
export function Modal({ open, onOpenChange, title, description, children, ...rest }: Props) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={OVERLAY} />
				<Dialog.Content
					{...rest}
					className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-1/2 animate-fade-in flex-col gap-4 overflow-y-auto rounded-panel border border-rim bg-surface p-5 shadow-(--shadow-glass) motion-reduce:animate-none"
				>
					<div>
						<Dialog.Title className={TITLE}>{title}</Dialog.Title>
						<Dialog.Description className={DESCRIPTION}>{description}</Dialog.Description>
					</div>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
