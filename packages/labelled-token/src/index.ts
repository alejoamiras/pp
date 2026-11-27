import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
// The browser app imports this entry, so it reaches the artifact and aztec.js's ABI loader only;
// Node-only tooling stays under scripts/. The explicit return type keeps the large JSON literal out
// of consumers' typechecks.
import tokenJson from "../../../contracts/bridge/aztec/labelled_token/target/labelled_token-LabelledToken.json" with { type: "json" }

export type { ContractArtifact }

export const labelledTokenArtifact: ContractArtifact = loadContractArtifact(tokenJson as never)
