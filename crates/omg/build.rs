// The omg binary links omg-music → screencapturekit's Swift bridge, which
// needs Swift runtime link args. `cargo:rustc-link-arg` does not propagate
// from dependencies, so this crate repeats the macOS link setup — keep it
// in sync with crates/music/build.rs.
include!("../music/build.rs");
