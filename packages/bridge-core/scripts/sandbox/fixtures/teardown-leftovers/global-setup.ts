import { assertNothingLeft } from "../../local-network"

export default function setup(): () => void {
	return () => assertNothingLeft({ anvilUrl: "", nodeUrl: "", stop: async () => {}, leftovers: () => ["registry row 1"] })
}
