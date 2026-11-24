# Testing

## Running

```sh
cargo test --workspace          # all unit + property tests
cargo test -p omg-proto-he      # one crate
cargo fmt --check               # formatting (enforced by CI)
cargo clippy --workspace --all-targets -- -D warnings
```

CI (`.github/workflows/ci.yml`) runs fmt, clippy and the test suite on
ubuntu-latest, macos-latest and windows-latest with the stable toolchain.

## Layout

- Unit tests live in `#[cfg(test)]` modules inside each crate's `src/`
  (e.g. `crates/proto-he/src/lib.rs`). Protocol crates keep their packet
  builders/parsers crate-private, so tests sit next to the code they cover.
- `mod prop_tests` in each protocol/model crate holds proptest properties:
  encode/decode roundtrips, bounds, and — most importantly — that every
  frame/payload parser is total (arbitrary bytes in, `Ok`/`Err` out,
  never a panic). `proto-khub916` has no parsers yet and is intentionally
  not fuzzed.

## Fixtures

Captured wire packets (real device replies, hex dumps) live in
`tests/fixtures/<proto>/`, e.g. `tests/fixtures/proto-mouse/`. Name files
`<scenario>.hex` (one byte per line or space-separated) or `.bin`, and
reference them from the test with a path relative to the workspace root
(`env!("CARGO_MANIFEST_DIR")` is per-crate; use `../../tests/fixtures/...`
from a crate-level integration test, or embed via `include_bytes!`).
