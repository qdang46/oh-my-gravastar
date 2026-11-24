//! GravaStar Mercury HE keyboards ("v2" web-driver protocol).
//!
//! 64-byte reports `[category, command, args…]`, report id 0. Categories:
//! device(1), global(2), layout&keymap(3), performance(4), lighting(5),
//! advanced keys(6), macros(7), fw update(8), custom(10), tri-mode(13).
//!
//! **Safety:** the protocol-layer blacklist from docs/plan.md §2 must never be
//! implemented — no factory reset, firmware update, gamepad mode, wipe or
//! restart commands.
//!
//! Port pending (separate bead); reference:
//! `orbit-gravastar/src/protocol/keyboard.rs`, `docs/protocol-keyboard.md`.
