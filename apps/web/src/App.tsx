import { source } from "#data"
import { ConnectPanel } from "./features/connect/ConnectPanel"

export function App() {
	return (
		<main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 font-sans">
			<header>
				<h1 className="text-2xl font-bold">Privacy pool bridge</h1>
				<p className="text-slate-600">Move labelled funds between the pool on Ethereum and Aztec.</p>
			</header>
			<ConnectPanel source={source} />
		</main>
	)
}
