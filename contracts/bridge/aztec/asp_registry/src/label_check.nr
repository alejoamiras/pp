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

pub global MAX_OBSERVATION_LAG: u64 = 1800;
pub global MAX_ROOT_AGE: u64 = 3600;
// One of the PXE's expiry rounding steps (3600, 1800, 1 s), so the deadline survives exactly and
// these spends share their expiry offset with other transactions.
pub global SPEND_WINDOW: u64 = 1800;

pub global ORIGIN_POOL: u8 = 0;
pub global ORIGIN_BIRTH: u8 = 1;
