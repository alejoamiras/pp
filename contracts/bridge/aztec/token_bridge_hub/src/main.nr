mod test;

// One hub serves every bridged ERC-20. An L1 PortalFactory creates a storage-less portal clone per
// token and sends a `register` message (the FACTORY is the L1 sender; the portal address travels in
// the content) that this contract consumes to learn the token's portal and to create the L2 token
// itself: the LabelledToken instance is derived in-circuit from the attested words with this hub as
// deployer and minter, so no party can pair a foreign portal or token with a real one.

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridgeHub {
    use aztec::{
        hash::hash_args,
        macros::{
            events::event,
            functions::{
                external, initialization_utils::compute_initialization_hash, initializer, internal,
                only_self, view,
            },
            storage::storage,
        },
        protocol::{
            address::{AztecAddress, EthAddress}, contract_class_id::ContractClassId,
            contract_instance::ContractInstance, public_keys::PublicKeys, traits::ToField,
        },
        publish_contract_instance::publish_contract_instance_for_public_execution,
        state_vars::{Map, PublicImmutable},
    };
    use bridge_message::{bridge_content_v1, exit_content_v1, ragequit_content_v1};
    use claim_secret_lib::derive_claim_secret;
    use compressed_string::FieldCompressedString;
    use labelled_token::LabelledToken;
    use pp_hash::hash_2;
    use register_hash_lib::{BIND_HARNESS_SECRET, get_register_content_hash, REGISTER_SECRET};

    // The public half of a ragequit: enough to settle it on Ethereum from chain data alone. It names
    // no Aztec account; the burn that backs it stays private.
    #[event]
    pub struct RagequitTicket {
        token: AztecAddress,
        payee: EthAddress,
        amount: u128,
        label: Field,
    }

    // The public exit's settlement preimage, so the exit settles on Ethereum from chain data alone.
    #[event]
    pub struct PublicExitTicket {
        token: AztecAddress,
        payee: EthAddress,
        amount: u128,
    }

    #[storage]
    struct Storage<Context> {
        l1_factory: PublicImmutable<EthAddress, Context>,
        token_class_id: PublicImmutable<ContractClassId, Context>,
        // Passed to every token this hub creates; part of each token's address.
        registry: PublicImmutable<AztecAddress, Context>,
        portal_of: Map<AztecAddress, PublicImmutable<EthAddress, Context>, Context>,
        token_of: Map<EthAddress, PublicImmutable<AztecAddress, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token_class_id: ContractClassId, l1_factory: EthAddress, registry: AztecAddress) {
        self.storage.token_class_id.initialize(token_class_id);
        self.storage.l1_factory.initialize(l1_factory);
        self.storage.registry.initialize(registry);
    }

    // ── Registration ───────────────────────────────────────────────────────────────────────

    // Publishes the derived token instance, then binds it. Only this hub can publish an instance
    // whose deployer is this hub, so this is the entrypoint every real caller uses.
    #[external("private")]
    fn register_token(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
    ) {
        let _ = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            true,
        );
    }

    // Publish-free variant for a harness that pre-registers the instance (the TXE cannot execute
    // the class-registry path). It consumes with a DIFFERENT secret than the factory commits to, so
    // on a real network no factory leaf can be spent through it — a caller who skipped the publish
    // would otherwise bind a token nothing can construct and burn the token's one-shot leaf.
    #[external("private")]
    fn bind_token(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
    ) {
        let _ = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            false,
        );
    }

    // The register message is consumed BEFORE anything is published or enqueued, so a wrong-metadata
    // or already-consumed attempt fails with no side effects: a stranded publish nullifier would make
    // that token unregisterable forever (the registry emits the address as a nullifier).
    #[internal("private")]
    fn _bind(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
        publish: bool,
    ) -> AztecAddress {
        let l1_factory = self.storage.l1_factory.read();
        let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
        let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
        self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);

        let name = word_to_str(name_word);
        let symbol = word_to_str(symbol_word);
        let hub = self.context.this_address();
        let registry = self.storage.registry.read();
        let token = derive_token(
            hub,
            self.storage.token_class_id.read(),
            erc20,
            name,
            symbol,
            decimals,
            registry,
        );

        if publish {
            publish_contract_instance_for_public_execution(self.context, token);
        }
        self.enqueue(LabelledToken::at(token).constructor(name, symbol, decimals, hub, registry));
        self.enqueue_self._register(erc20, portal, token);
        token
    }

    // First registration wins: both PublicImmutables refuse a second initialize, so a second
    // factory-authored leaf for the same ERC-20 (a hypothetical — createPortal is idempotent) cannot
    // re-point an existing token.
    #[external("public")]
    #[only_self]
    fn _register(erc20: EthAddress, portal: EthAddress, token: AztecAddress) {
        self.storage.portal_of.at(token).initialize(portal);
        self.storage.token_of.at(erc20).initialize(token);
    }

    // ── Claim ──────────────────────────────────────────────────────────────────────────────

    // The commitment and the secret are rebuilt with the caller as recipient, so only the bound
    // account can claim and the note keeps the label inside the pool's change commitment.
    // INVARIANT: the only consumer of a bridge message; `check-sole-consumer.sh` pins this dataflow.
    #[external("private")]
    fn claim_from_pool(
        token: AztecAddress,
        amount: u128,
        nullifier: Field,
        change_precommitment: Field,
        label: Field,
        claim_salt: Field,
        message_leaf_index: Field,
    ) {
        let recipient = self.msg_sender();
        assert(label != 0, "claim label is zero");
        let portal = self.storage.portal_of.at(token).read();
        let commitment = hash_2([change_precommitment, label]);
        let secret = derive_claim_secret(claim_salt, recipient);
        let content = bridge_content_v1(nullifier, commitment, amount);
        self.context.consume_l1_to_l2_message(content, [secret], portal, message_leaf_index);
        self.call(LabelledToken::at(token).mint_from_bridge(recipient, amount, label));
    }

    // ── Ragequit ───────────────────────────────────────────────────────────────────────────

    // Every refusal comes before the burn, and the burn, the message and the ticket share one
    // revert phase: all three land or none does.
    #[external("private")]
    fn ragequit(token: AztecAddress, payee: EthAddress, amount: u128, label: Field) {
        let from = self.msg_sender();
        let portal = self.storage.portal_of.at(token).read();
        // The portal refuses to pay itself (`PayeeIsPortal`), so this exit would burn and never settle.
        assert(payee != portal, "exit payee is the portal");
        let content = ragequit_content_v1(payee, amount, label);
        self.call(LabelledToken::at(token).burn_for_exit(from, amount, label));
        self.context.message_portal(portal, content);
        self.enqueue_self._ragequit_ticket(token, payee, amount, label);
    }

    #[external("public")]
    #[only_self]
    fn _ragequit_ticket(token: AztecAddress, payee: EthAddress, amount: u128, label: Field) {
        self.emit(RagequitTicket { token, payee, amount, label });
    }

    // ── Public exit ────────────────────────────────────────────────────────────────────────

    // The hub's refusals come before the burn, so a refused exit names its own cause, not the token's.
    #[external("public")]
    fn exit_public(token: AztecAddress, payee: EthAddress, amount: u128) {
        let portal = self.storage.portal_of.at(token).read();
        // The portal refuses to pay itself (`PayeeIsPortal`), so this exit would burn and never settle.
        assert(payee != portal, "exit payee is the portal");
        let content = exit_content_v1(payee, amount);
        self.call(LabelledToken::at(token).burn_public_for_exit(self.msg_sender(), amount));
        self.context.message_portal(portal, content);
        self.emit(PublicExitTicket { token, payee, amount });
    }

    // ── Discovery ──────────────────────────────────────────────────────────────────────────

    // Zero when unregistered — discovery must not revert. The claim and both exits use the
    // hard-reverting read.
    #[external("public")]
    #[view]
    fn token_for(erc20: EthAddress) -> AztecAddress {
        let slot = self.storage.token_of.at(erc20);
        if slot.is_initialized() {
            slot.read()
        } else {
            AztecAddress::zero()
        }
    }

    #[external("public")]
    #[view]
    fn portal_for(token: AztecAddress) -> EthAddress {
        let slot = self.storage.portal_of.at(token);
        if slot.is_initialized() {
            slot.read()
        } else {
            EthAddress::zero()
        }
    }

    // ── Library ────────────────────────────────────────────────────────────────────────────

    // The L1 word is the only datum shared by event, message, manifest and journal. `to_bytes` is a
    // 31-limb decomposition, so a word wider than 31 bytes cannot reach the constructor hash at all.
    #[contract_library_method]
    pub fn word_to_str(word: Field) -> str<31> {
        FieldCompressedString::from_field(word).to_bytes().as_str_unchecked()
    }

    // The token address is a pure function of (hub, class, erc20, attested metadata, registry).
    // Derived from the typed, re-serialized constructor args — never from a caller-supplied args hash.
    #[contract_library_method]
    pub fn derive_token(
        hub: AztecAddress,
        token_class_id: ContractClassId,
        erc20: EthAddress,
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        registry: AztecAddress,
    ) -> AztecAddress {
        let call = LabelledToken::interface().constructor(name, symbol, decimals, hub, registry);
        let initialization_hash = compute_initialization_hash(call.selector, hash_args(call.args));
        ContractInstance {
            salt: erc20.to_field(),
            deployer: hub,
            original_contract_class_id: token_class_id,
            initialization_hash,
            immutables_hash: 0,
            public_keys: PublicKeys::default(),
        }
            .to_address()
    }
}
