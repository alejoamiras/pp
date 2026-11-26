# Aztec spikes

Small contracts and tests that measure four behaviours of Aztec 6.0.0 before the token is designed. They are evidence, not product code.

| Crate | Question |
|---|---|
| `poseidon_spike` | Does `noir-lang/poseidon` match the pool's circom Poseidon, including a depth-18 LeanIMT path? |
| `label_token` | Can a note `{label, value}` minted with constrained delivery be found by a recipient that never registered the sender? Can a partial note commit to a private label and be completed in public with only an amount? |
| `root_registry`, `registry_reader` | Can a private function read another contract's `(sequence, root, time)` record at its anchor block, check freshness and bound its expiry? What happens if the record changes before the transaction lands? |

`test/q*.test.ts` hold the local-network tests, one file per question; each prints `MEASURE <name> {json}` lines. `vectors/gen.ts` regenerates the Poseidon and LeanIMT vectors from MIT libraries (`bun run vectors`, checked by `bun run vectors:check`).

## Run

Needs the Aztec 6.0.0 toolchain at `~/.aztec/versions/6.0.0` (override with `AZTEC_HOME`), Bun 1.4 and Node 24.

```sh
bun install --frozen-lockfile
bun run compile        # aztec compile: transpiled artifacts in target/
bun run test:nr        # Noir tests on a TXE server this run starts and stops
bun run test:net       # TypeScript tests on a local network this run starts and stops
```

Both runners claim their ports in `~/.agents/ports.md`, keep their data under `~/.cache/pp/aztec-spikes/<run>`, and stop only the process groups they started. Each prints its `RUN_ID`.
