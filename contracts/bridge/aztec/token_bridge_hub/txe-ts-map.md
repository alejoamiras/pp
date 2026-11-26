# TokenBridgeHub — what each TXE test proves, and where the other side of the bridge pins it

The hub's TXE suite (`src/test/*.nr`, every name in `txe-manifest.txt`) runs the real contract
against injected L1→L2 messages. Every property that crosses the L1↔L2 boundary has a counterpart on
the L1 side (`contracts/bridge/evm/test`), in `packages/bridge-spec` or in `packages/bridge-core`;
this map is how a reviewer checks that a property is pinned on BOTH ends, not asserted on one and
assumed on the other.

The TXE cannot run the protocol class-registry path (`publish_contract_instance_for_public_execution`),
so tests pre-register each LabelledToken instance through the raw deploy oracle and drive the
publish-free `bind_token`. It consumes with a HARNESS secret a real factory never commits to
(`bind_cannot_consume_a_real_factory_leaf`); `register_token` consumes with the factory secret and
then publishes — `register_token_reaches_the_publish` pins that it gets as far as the publish's
class-nullifier read, and the local-network suite is the gate for the publish itself.

| Property | TXE (`src/test/`) | L1 / TS counterpart |
|---|---|---|
| The register message is `sha256ToField(register(token, portal, nameWord, symbolWord, decimals))` with secret `compute_secret_hash([0])` | `register.nr::bind_token_alone_registers`, `register_token_reaches_the_publish` | `Keystone.t.sol`, `register-hash.test.ts`, keystone crate `register_matches_l1_and_ts` / `register_secret_hash_is_pinned` |
| Only the factory's messages register (sender-keyed) | `register_from_foreign_sender_rejected` | `BlackhatFactory` F-1 (front-run yields the identical factory-sent message); `PortalFactoryInvariant` I4 (one register per portal) |
| The portal inside the content is the one bound | `register_with_swapped_portal_rejected`, `two_tokens_register_independently` | `PortalFactory.t.sol` tuple test (`portal == predictPortal`, event/registration/message agree); `FormalFactory` `check_predictPortal_isCreate2OfInitcode` |
| Wrong or swapped metadata fails in the private phase with no side effects (a correct retry afterwards is observable only on a network — a failed TXE call aborts the test) | `wrong_metadata_fails_before_any_side_effect`, `register_with_wrong_name_word_rejected`, `register_with_swapped_words_rejected` | `BlackhatFactory` F-4 (metadata frozen at creation) |
| One registration per ERC-20, first wins (both the `token_of` and the `portal_of` branch); leaves cannot be replayed | `register_replay_of_same_leaf_rejected`, `second_factory_leaf_for_same_erc20_rejected`, `second_factory_leaf_with_same_words_different_portal_rejected` | `createPortal` idempotence (`PortalFactory.t.sol`, `PortalFactoryInvariant` I1) |
| Anyone may register; the depositor's claim is unaffected | `relayer_registers_then_depositor_claims` | `BlackhatFactory` F-1 |
| Discovery never reverts | `discovery_reads_zero_for_unregistered` | `factory-abi.ts` `portalOf`/`tokenOf` (zero when unregistered) |
| Every u8 decimals registers | `decimals_extremes_register` | `PortalFactory.t.sol` decimals 0/18/19/38/255 |
| The in-circuit LabelledToken address equals bridge-core's derivation, registry included | `keystone_hub_token_address_matches_bridge_core`, `keystone_hub_token_address_binds_the_registry`, `keystone_oversized_word_is_rejected` | `hub-token.test.ts`; `noir-artifact-classids.test.ts` (LabelledToken + hub class ids) |
| The claim consumes `bridge_content_v1(nullifier, hash_2([change_precommitment, label]), amount)` and mints that amount under that label | `claim.nr::claim_from_pool_mints_under_the_label`, `…_wrong_label`, `…_wrong_precommitment`, `…_wrong_amount`, `…_wrong_nullifier` | `BridgeMessageV1.sol` + `BridgeMessageV1.t.sol`; `@pp/bridge-spec` `bridgeContentV1` and `vectors/v1.json`; keystone crate `vectors_v1.nr` (`vectors:nargo`) |
| The secret is derived from the claim salt and the claiming account, so no other account can claim | `…_other_account`, `…_wrong_salt` | `claim-secret.ts` + keystone crate `derive_claim_secret` vectors; `check-sole-consumer.sh` (the claim's dataflow) |
| The portal comes from the claimed token, so a deposit through portal A cannot mint token B | `…_wrong_token` | — (L2-only: the expected sender is `portal_of[token]`) |
| Each message is consumable once, at its own leaf | `…_wrong_leaf_index`, `…_replay` | — (L2 message tree) |
| An unregistered token dies on the uninitialized portal slot | `…_unregistered_token` | — (L2-only) |
| Zero amount and zero label are refused by name before any consume | `…_zero_amount` (`AmountOutOfRange`, the encoder's), `…_zero_label` (`claim label is zero`, the hub's) | `BridgeMessageV1.t.sol` (`AmountOutOfRange`); `@pp/bridge-spec` `vectors/rejections.ts` |
| A ragequit burns exactly `amount` of the caller's `label` notes and leaves its other labels | `ragequit.nr::ragequit_burns_exactly_with_no_registry`, `ragequit_keeps_other_labels` | the token's own `burn_for_exit` cases (`labelled_token/src/test/burn.nr`) |
| The ticket is the transaction's only public log and carries the burn's token, payee, amount and label; nothing in it names the holder | `ragequit_ticket_matches_the_burn` | the local-network suite reads it back through `getPublicEvents` |
| The exit message is `ragequit_content_v1(payee, amount, label)` to the token's portal | — (a TXE block carries no L2→L1 message) | `BridgeMessageV1.sol` + `BridgeMessageV1.t.sol`; `@pp/bridge-spec` `ragequitContentV1`; the local-network suite matches the transaction's message hash |
| Every refusal comes before the burn, by name: a burn-first hub fails each with another message (the token's `Balance too low` or `zero amount`, or a missing token instance) | `…_zero_amount` (`AmountOutOfRange`), `…_zero_payee` (`ZeroPayee`), `…_wide_payee` (`PayeeOutOfRange`), `…_zero_label` (`LabelOutOfRange`), `…_portal_payee` (`exit payee is the portal`, the hub's), `…_unregistered_token`; controls `…_over_balance`, `…_other_label` | `BridgeMessageV1.t.sol` and `@pp/bridge-spec` `vectors/rejections.ts` (the shared names); the local-network suite reads the balance after each refusal |
| `_register` and `_ragequit_ticket` are only-self | `guards.nr` | — |
