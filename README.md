# oh-my-gravastar

Agent-first, offline CLI (`omg`) for configuring GravaStar keyboards and mice.
Every command supports `--json` so AI agents can drive it. No daemon, no
network, no telemetry.

> Not affiliated with GravaStar. "GravaStar" is a trademark of its owner.

## Quickstart

```sh
cargo build
./target/debug/omg devices          # list detected GravaStar devices
./target/debug/omg devices --json   # same, machine-readable
./target/debug/omg --version
./target/debug/omg probe            # diagnostic stub (protocols land per-bead)
./target/debug/omg mouse info       # Compx mouse: model, sensor, link (needs a mouse)
```

Global flags: `--json`, `--device <path|vid:pid|name-substring>`.
Exit codes: `0` ok, `1` error, `2` no device, `3` unsupported.

On macOS, `omg devices` uses hidapi/IOHIDManager. If the K1 Pro does not
appear, check System Settings → Privacy & Security → Input Monitoring and
restart the terminal/app (see docs/plan.md F11).

## Workspace layout

```
crates/
  hid/             hidapi Link trait, transfer(), device enumeration + identity tables
  proto-he/        GravaStar HE keyboard "v2" protocol        (ported, F2)
  proto-mouse/     Compx mouse protocol (Mercury M/X series)  (ported, F4)
  proto-khub916/   K1/K98 "916" feature-report protocol       (reversing)
  model/           key labels, key sizes, lighting mode tables
  omg/             the CLI binary (clap)
```

See `docs/plan.md` for the protocol map, milestones and safety contract.
