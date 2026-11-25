//! Agent-facing desired-state configuration surface (read-only R1 slice).
//!
//! Implements the schema-driven workflow from
//! `docs/specs/ADR-full-desired-state-config.md` and
//! `docs/specs/rust-cli-config-migration-spec.md` §15 milestone R1+R2:
//!
//! - [`schema`] — versioned JSON Schema (draft 2020-12) registry per device
//!   family, with `x-omg` capability/verification metadata.
//! - [`document`] — strict full-desired-state document parser/validator.
//!   "Full" means every managed writable field is present; missing fields
//!   are errors, never "leave unchanged" (ADR §2).
//! - [`state`] — fail-closed current-state readers (AGENTS.md §Safety 6:
//!   a short/failed read is an error, never a default).
//! - [`diff`] — desired-vs-current comparison, no writes.
//! - [`guide`] — concise workflow/safety guide.
//! - [`commands`] — `omg schema`, `omg guide`, `omg config get|validate|diff`.
//!
//! **No writes exist in this slice.** `config apply` is intentionally a
//! stub; the only device traffic is documented read-only queries.

pub mod commands;
pub mod diff;
pub mod document;
pub mod error;
pub mod guide;
pub mod schema;
pub mod state;

pub use error::ConfigError;
