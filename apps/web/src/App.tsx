import { loadSource } from "#data"
import { SourceGate } from "./app/SourceGate"

export function App() {
	return <SourceGate load={loadSource} />
}
