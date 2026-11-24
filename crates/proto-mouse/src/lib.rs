//! GravaStar mice with a Compx chipset (2.4 GHz receiver or cable).
//!
//! Output report 8, 16-byte payload `[cmd, 0, addrHi, addrLo, len, data×10,
//! checksum]` with `(8 + sum) & 0xFF == 0x55`. Settings live in a flash map
//! read with 0x08 and written with 0x07.
//!
//! **Safety:** writes are restricted to the known `WRITABLE` flash ranges;
//! pairing (0x05/0x06), factory reset (0x09), RF channel (0x31) and the
//! bootloader range (0xB0–0xB7) are never implemented.
//!
//! Port pending (separate bead); reference:
//! `orbit-gravastar/src/protocol/mouse.rs`, `docs/protocol-mouse.md`.
