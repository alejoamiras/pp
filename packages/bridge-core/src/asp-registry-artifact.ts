import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
// The ASP root registry's Noir artifact, on its own entry point so that importing `./artifacts` (which
// every app path does) never parses it.
import registryJson from "../../../contracts/bridge/aztec/asp_registry/target/asp_registry-AspRootRegistry.json" with { type: "json" }

export const aspRootRegistryArtifact: ContractArtifact = loadContractArtifact(registryJson as never)
