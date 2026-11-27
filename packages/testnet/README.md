# @pp/testnet

The schema of the bridge's testnet deployment file: one committed JSON file per target, holding its
`network` (chain, rollup and endpoints), the `expected` addresses and amounts, an operator target's
`operator` section, and the `pool` and `bridge` sections a deploy adds. The guarded commands that write
and read it on Sepolia are to follow in this package.

## `@pp/testnet/schema`

The package's only entry. Its runtime imports reach zod and nothing else (no Node, Bun or viem module),
so a browser build can import it; `src/schema.test.ts` holds it to that.

- `parseDeployment(json)` validates a decoded file strictly and throws naming every offending field;
  `serializeDeployment` writes only what `parseDeployment` accepts, with bigints as decimal strings.
- `requireSections(d, sections)` narrows to a file that carries those sections.
- `isPinned(kind, url)` and `PINNED_URLS` hold every public endpoint a testnet run may reach. A URL is
  pinned by equality, never by pattern; a build should refuse any other.
