import { source } from "#data"
import { ConnectPanel } from "./features/connect/ConnectPanel"

export function App() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:py-10">
			<header>
				<h1 className="text-2xl font-bold tracking-[-0.02em]">Privacy pool bridge</h1>
				<p className="text-ink-3">Move labelled funds between the pool on Ethereum and Aztec.</p>
			</header>
			<ConnectPanel source={source} />
		</main>
	)
}
