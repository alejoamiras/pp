import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
// The L2 hub's Noir artifact and the token class it derives. Imported here so the browser app can
// register instances with a PXE without reaching across packages. The JSON is large; the explicit
// ContractArtifact type keeps the huge literal from leaking into consumers' typechecks. The import
// attribute is what Node's ESM loader (the Playwright runner) requires for JSON; Bun and Vite
// accept it too. The token's JSON is read by path, not through `@pp/labelled-token`, so that
// package's test harness may depend on this one without a cycle.
import tokenJson from "../../../contracts/bridge/aztec/labelled_token/target/labelled_token-LabelledToken.json" with { type: "json" }
import hubJson from "../../../contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json" with {
	type: "json",
}

export const tokenBridgeHubArtifact: ContractArtifact = loadContractArtifact(hubJson as never)

export const labelledTokenArtifact: ContractArtifact = loadContractArtifact(tokenJson as never)
