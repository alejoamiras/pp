//! How a token checks a label against the registry from a private function.
//!
//! Time rules, in seconds, against `root_time` (the Ethereum block time the poster observed):
//! - a post lands only while `now - root_time <= MAX_OBSERVATION_LAG`;
//! - a spend needs `root_time + MAX_ROOT_AGE >= anchor + SPEND_WINDOW` and expires at
//!   `anchor + SPEND_WINDOW`, so it lands at most `MAX_ROOT_AGE` after `root_time`.
//! A record therefore serves anchors up to `root_time + 1800`. Read from a block `L` s old and included
//! `I` s later, it is usable for `1800 - L - I` s: about 11-17 minutes on Sepolia's finalized tag
//! (`L` = 768-1152), which bounds how often the poster must land a post. If finality stalls, checked
//! spends stop from `root_time + 1800`; claims and ragequits never read the registry.
//!
//! Callers pass their own immutable registry address, never an argument, and the constrained common
//! origin of the notes they spend.

use crate::AspRootRegistry::{self, RootRecord};
use aztec::{
    context::{PrivateContext, PublicContext},
    history::storage::public_storage_historical_read,
    protocol::{address::AztecAddress, traits::{Deserialize, FromField, Serialize}},
    utils::WithHash,
};

pub global MAX_OBSERVATION_LAG: u64 = 1800;
pub global MAX_ROOT_AGE: u64 = 3600;
// One of the PXE's expiry rounding steps (3600, 1800, 1 s), so the deadline survives exactly and
// these spends share their expiry offset with other transactions.
pub global SPEND_WINDOW: u64 = 1800;

pub global ORIGIN_POOL: u8 = 0;
pub global ORIGIN_BIRTH: u8 = 1;

#[derive(Deserialize, Eq, Serialize)]
pub struct TreeRoot {
    pub root: Field,
    pub time: u64,
}

/// Both trees, so a public step can compare them without naming the origin. Each tree carries its own
/// time, which today is the record's single `root_time`.
#[derive(Deserialize, Eq, Serialize)]
pub struct AnchorRoots {
    pub pool: TreeRoot,
    pub birth: TreeRoot,
}

/// For the unshield's `only_self` public step: `roots` must still be the registry's current roots.
pub unconstrained fn assert_current(context: PublicContext, registry: AztecAddress, roots: AnchorRoots) {
    let current = AspRootRegistry::at(registry).get_current().view(context);
    assert(
        (current.pool_root == roots.pool.root) & (current.birth_root == roots.birth.root),
        "roots changed",
    );
    // Implied on a real network by the private check plus the expiry; kept so this step stands alone.
    assert(current.root_time + MAX_ROOT_AGE >= context.timestamp(), "current root too old");
}

/// The intake that receives birth announcements, as of the anchor. Zero means shields are paused.
pub fn birth_intake_at_anchor(context: &mut PrivateContext, registry: AztecAddress) -> AztecAddress {
    assert(!registry.is_zero(), "registry unset");
    let intake = AztecAddress::from_field(public_storage_historical_read(
        context.get_anchor_block_header(),
        AspRootRegistry::storage_layout().birth_intake.slot,
        registry,
    ));
    assert(!intake.is_zero(), "birth intake unset");
    intake
}

/// The origin's root and both trees, after the freshness rule and the expiry; the path is checked next.
pub(crate) fn fresh_roots(context: &mut PrivateContext, registry: AztecAddress, origin: u8) -> (Field, AnchorRoots) {
    assert(!registry.is_zero(), "registry unset");
    assert(origin <= ORIGIN_BIRTH, "unknown origin");
    let record = record_at_anchor(context, registry);
    let root = if origin == ORIGIN_POOL { record.pool_root } else { record.birth_root };
    // Also rejects an unposted registry and one whose poster was just replaced.
    assert(root != 0, "root unset");
    let anchor = context.get_anchor_block_header().timestamp();
    // Holds only through `post_root`'s `root_time <= now`; a record dated after its anchor would
    // stretch the freshness window.
    assert(record.root_time <= anchor, "root after anchor");
    assert(record.root_time + MAX_ROOT_AGE >= anchor + SPEND_WINDOW, "root too old");
    context.set_expiration_timestamp(anchor + SPEND_WINDOW);
    let time = record.root_time;
    (
        root,
        AnchorRoots {
            pool: TreeRoot { root: record.pool_root, time },
            birth: TreeRoot { root: record.birth_root, time },
        },
    )
}

/// The whole record for either origin, so the node serving the witness cannot tell which tree is used.
pub(crate) fn record_at_anchor(context: &mut PrivateContext, registry: AztecAddress) -> RootRecord {
    WithHash::<RootRecord, 5>::historical_public_storage_read(
        context.get_anchor_block_header(),
        registry,
        AspRootRegistry::storage_layout().current.slot,
    )
}
