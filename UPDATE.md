# Updating the Aztec line and Noir

What a bump of the Aztec line touches in this repository. From 6.0 the line publishes as
`@aztec-labs/*` and `@aztec-foundation/*`, and nothing resolves under the old `@aztec/*` scope; it is
exact-pinned and bumped by hand. A bump installs fresh publishes, so it clears the 7-day release-age
gate only through the temporary excludes in § The pin surface, removed in the same PR
([`AGENTS.md`](AGENTS.md) § Dependency policy).

> **Convention:** code that types against an `@aztec` shape (an artifact field, a node RPC result, a
> wallet-sdk capability) adds an entry to § Couplings below, with its file, so the next bump has a
> checklist.

Current line: **`6.0.0`**. Labs and foundation number their releases separately, and the standards
package keeps a pin of its own:

- **`@aztec-labs/*` at `6.0.0`**, the `@aztec-labs/aztec.js` pin. The Noir contract source follows
  this number (the aztec-nr tags in every `Nargo.toml`, `contracts/bridge/aztec/scripts/compile.sh`,
  the committed `target/*.json`), and so does the toolchain at `~/.aztec/versions/6.0.0`. The Nulo
  wallet's packages sit at `0.3.0`, whose Aztec peers are exact labs `6.0.0` pins.
- **`@aztec-foundation/*` at `6.0.0`** (`bb.js`, `l1-artifacts`, `noir-acvm_js`,
  `noir-noirc_abi`): the version the locked `@aztec-labs/aztec.js` requires.
- **`@aztec-foundation/aztec-standards` at `6.0.0`**, its own pin. It follows the tags of
  `AztecProtocol/aztec-standards`, which the hub's Noir `token` dep names too.

[`scripts/ci-cd/aztec-line.test.ts`](scripts/ci-cd/aztec-line.test.ts) holds each scope to its own
version: labs at the aztec.js pin, foundation at the version labs' lock entry requires for
`@aztec-foundation/l1-artifacts`, `aztec-standards` at its declared pin, every root
`patchedDependencies` key at the foundation version, and every Aztec declaration in every manifest
at exactly its scope's version. It also fails on any resolved `@aztec/*` package, in the root
lockfile and in the TXE server's. The hub's class ids depend on these inputs.

## Before you bump

1. The Nulo wallet's repository publishes `@nulo-sh/wallet-crypto`, `@nulo-sh/resolve-asset` and
   `@nulo-sh/wallet-sdk-schema-patch` on the new line first.
   [`scripts/ci-cd/published-packages.test.ts`](scripts/ci-cd/published-packages.test.ts) holds each
   peer to this repository's pin, so the bump waits for those versions.
2. Read the upstream `@aztec-labs/aztec.js` changelog for the target version, then scan the
   aztec-node compare view between the two tags for `!:` commits and grep this repository for the
   symbols they break. aztec-nr lives in `aztec-labs-eng/aztec-nr`, the standards in
   `AztecProtocol/aztec-standards`.

## The pin surface

- `@aztec-labs/*` and `@aztec-foundation/*` exact pins in `packages/bridge-core/package.json`,
  `packages/e2e-kit/package.json` and `contracts/bridge/aztec/txe-server/package.json`, each scope at
  its own version. Both workspaces pin stock `viem` at exactly the version the line depends on
  (`2.57.1` on 6.0.0), so `flows.ts`'s `OutboxContract` client shares the Aztec packages' copy.
- The three packages the Nulo wallet's repository publishes, at the versions published for the new
  line.
- The Noir wasm patches: `patches/@aztec-foundation%2Fnoir-{acvm_js,noirc_abi}@<v>.patch` and the
  `patchedDependencies` keys in the root `package.json`. They name the foundation version; a bump
  regenerates them, or they silently stop applying.
- `bunfig.toml` `minimumReleaseAgeExcludes`: add every new-line name while `bun install` resolves the
  new line, then delete them in the same PR and prove the lockfile with
  `bun install --frozen-lockfile --force`.
- The wire-format package: `packages/bridge-spec/package.json` pins the labs packages too, and
  `contracts/bridge/aztec/pp_hash` pins `noir-lang/poseidon` by tag with its resolved commit in
  `pp_hash/README.md` (CI compares the two). A bump that moves aztec-nr's poseidon pin, Aztec's
  Poseidon2 or `sha256_to_field` shows up as a failure of `vectors:check`, the TS vector suite or
  `vectors:nargo`; fix the implementation, never regenerate v1 (`packages/bridge-spec/README.md`).
- CI resolves two toolchains separately: `.github/actions/setup-aztec` installs the toolchain at the
  `@aztec-labs/aztec.js` pin read from `packages/bridge-core/package.json`, and
  `_bridge-contracts.yml` installs the Noir toolchain from the crates' `Nargo.toml` tag.

## Couplings

- **The node's local-network environment.** The harness starts the CLI entry directly, not the
  `aztec` wrapper script, whose `start --local-network` branch also launches an anvil on a fixed
  port. `nodeEnv` in `packages/bridge-core/scripts/sandbox/local-network.ts` copies the variables that
  branch exports; compare them with the new version's `scripts/aztec.sh`.

- **Noir wasm dedupe**: the test wallet's `packages/e2e-kit/test-wallet/vite.config.mts` dedupes
  `@aztec-foundation/noir-noirc_abi` and `@aztec-foundation/noir-acvm_js`; without it `initAbi()` and
  `abiEncode()` land in different module scopes and the wasm instance never resolves.
- **Hub ↔ factory, a circular binding deployed as one unit.** The hub's address is salted with the
  factory's (`salt = Fr(factory)`) and the factory's constructor takes the hub.
  `packages/bridge-core/scripts/generation.ts` predicts the factory from the deployer's pending nonce
  and refuses to broadcast if it moved.
- **`tokenClassId` ↔ the standards `Token` artifact.** The hub's `token_class_id` is computed from the
  installed `@aztec-foundation/aztec-standards` artifact; every L2 token derives from it
  (`src/hub-token.ts`, class id pinned by `noir-artifact-classids.test.ts`, address vector by
  `hub-token.test.ts`).
- **Hub → the protocol's `ContractInstanceRegistry`.** `register_*` calls aztec-nr's
  `publish_contract_instance_for_public_execution`, which the running network must still route. The
  TXE cannot exercise it; the sandbox's first-time registration flows are the only canary.
- **Two toolchain readers, one version.** `packages/bridge-core/scripts/sandbox/local-network.ts`
  boots `aztec start --local-network` from `~/.aztec/versions/<@aztec-labs/aztec.js pin>`, while
  `compile.sh`, `nargo.sh` and `run-txe-tests.sh` default `AZTEC_HOME` to a literal version. Move
  both together.
- **Token `constructor_with_minter` arity**: five parameters since 5.0.1, the last `auth_contract`.
  The hub's `derive_token` and `src/hub-token.ts` both pin it.

## After you bump

- `bun run typecheck:all` and `bun run test:all`, each judged by its exit code.
- The contract suites and the integration run ([`AGENTS.md`](AGENTS.md) § Fast loop);
  `bridge-contracts.yml` runs them on the PR.
