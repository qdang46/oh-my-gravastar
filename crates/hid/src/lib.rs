//! HID link abstraction plus GravaStar device identification.
//!
//! Safety contract (docs/plan.md §2): this crate is transport only. It never
//! sends protocol commands; writes happen exclusively inside the `proto-*`
//! crates under their own safety rules.

pub mod devices;
mod link;

pub use devices::{classify, find_devices, DeviceInfo, DeviceKind};
pub use link::{transfer, HidLink, Link, NoAnswer};
