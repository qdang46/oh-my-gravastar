# AGENTS.md — oh-my-gravastar working rules

Read `docs/plan.md` first; it is the source of truth for scope, protocols and
milestones. `README.md` documents the shipped CLI. Upstream reference code:
`../oh-my-gravastar-upstream/` (`orbit-gravastar` Rust, MIT — port logic,
never copy egui/UI code; `OmaGravastar` for Linux udev/Quickshell reference;
`HallJoy` for the SparkPlayJoy analog semantics).

## Scope tracking — beads are the source of truth

Work is tracked in beads (`.beads/`, SQLite + JSONL). Use `br` for issues
(`br list`, `br show <id>`, `br update <id> -s in_progress`, `br close <id>`)
and `bv` for the TUI. Bead descriptions carry the acceptance criteria; `docs/plan.md`
carries the design. When scope, priorities or acceptance criteria change,
update the bead — do not fork the plan into ad-hoc notes.

## Workspace layout

Cargo workspace (`resolver = "2"`, Rust 1.85, edition 2021,
`unsafe_code = "forbid"` workspace-wide):

```
crates/
  hid/             omg-hid — hidapi Link trait, transfer()/transfer_exact(),
                   NoAnswer, find_devices()/classify() identity tables
  proto-he/        omg-proto-he — GravaStar HE keyboard "v2" protocol
                   (64-byte reports, usage page 0xFFB0); ported from orbit
  proto-mouse/     omg-proto-mouse — Compx mouse protocol (Mercury M/X);
                   ported from orbit
  proto-khub916/   omg-proto-khub916 — K1/K98 "916" feature-report protocol
                   (reversed spec in docs/protocol-khub916.md; impl WIP)
  proto-sparkplayjoy/ omg-proto-sparkplayjoy — 6x21 analog protocol,
                   read-only (spec in docs/protocol-sparkplayjoy.md;
                   CLI: `omg kb travel-matrix`)
  model/           omg-model — key labels, key sizes, lighting mode tables
  omg/             the `omg` CLI binary (clap derive)
web/               WebHID PWA (Vite + TS). A write surface too — the §Safety
                   contract applies, with a confirm dialog + snapshot
                   (web/src/safety/) standing in for `--yes`
docs/
  plan.md                    scope, protocol map, milestones, safety contract
  platforms.md               per-OS HID notes + troubleshooting
  protocol-he-v2.md          HE keyboard v2 spec (port notes)
  protocol-compx-mouse.md    Compx mouse spec (port notes)
  protocol-khub916.md        khub916 spec (reversed from vendor JS)
  protocol-sparkplayjoy.md   6x21 analog spec (from HallJoy analysis)
  research/khub-webapp/      vendor JS mirror — READ-ONLY reference
```

Dependency direction: `omg` → `proto-*` / `model` → `hid`; `hid` depends on
nothing internal and must never send protocol commands.

## Safety contract (non-negotiable, from plan.md §2)

1. **Read-only by default.** Every write subcommand requires `--yes` and
   prints the exact change first; without `--yes` the command bails before
   any bytes are sent. Calibration (`kb calibration start|stop`) is a device
   operation and also requires `--yes`.
2. **Protocol-layer blacklist — never implement, even later:**
   - HE keyboard: `02 01` factory reset, `08 xx` firmware update,
     `0A 01 01 FF` wipe, `10 02` gamepad mode, `02 0F 01` restart,
     `02 09` default switch, categories `0x0C/0x0E/0x0F`.
   - Compx mouse: `05/06` pairing, `09` factory reset, `31` RF channel,
     `B0–B7` bootloader range. Mouse writes additionally restricted to the
     known `WRITABLE` flash ranges (port of orbit's allowlist).
   - khub916: nothing until the reverse is documented and proven read-only
     (cmd 17 reset and all `→` writes in docs/protocol-khub916.md §6 are
     currently off-limits).
3. **Write → read-back verify** on every mutation; report `verified`.
   `kb polling set` is the documented exception: the keyboard restarts and
   drops off the bus, so a missing read-back is reported unverified, not an
   error.
4. **Range validation** before send (actuation ≤ switch max travel — 3.5 mm
   UFO / 3.4 mm otherwise, deadzone ≤ 1 mm, palette indices 0–7, mouse
   `WRITABLE` flash ranges only).
5. No credentials/tokens/serial numbers in logs or JSON unless
   `--include-serial` is passed (flag is reserved in plan.md; do not emit
   serials in the meantime).
6. **Whole-table writes need a trustworthy base.** Read-modify-write of a
   full table (keymap, macro region, light blob, adv-key history) may only
   proceed when the base read succeeded, is the expected length, and every
   slot decodes to a **known** tag. A short, empty or failed read is an
   ABORT — never substitute `?? []`, `unwrap_or_default`, or zeros. Writing
   a table built on a guessed base is how a layer silently gets wiped.
7. **Unknown tag ⇒ read-only, byte-preserved.** If the decoder cannot name
   a value (tag not in `docs/protocol-*.md`), that slot is opaque: carry it
   through byte-identical, never render it as editable, and never let a UI
   or CLI default it to 0. Adding a tag means documenting it first.
8. **Read-back verify ≠ semantic preservation.** It proves the bytes
   landed, not that the rest of the table still means what it did. Any
   claim that an edit only touched some slots must be backed by comparing
   every untouched slot against the **original** read.

## Conventions

- Every command that emits data supports `--json` (global flag). Public
  types that cross the JSON boundary derive `serde::Serialize`.
- Exit codes: `0` ok / `1` error / `2` no device / `3` unsupported.
- New device identities go into `crates/hid/src/devices.rs` tables with a
  comment citing the source (official driver table or upstream constant).
- `DeviceInfo::open_link()` opens a `HidLink`; protocol crates take
  `Box<dyn Link>`-style links so tests can inject a mock. `transfer()` =
  write + accept-predicate read; `transfer_exact()` = fixed report count
  under one deadline (SparkPlayJoy multi-report frames).
- Errors: `anyhow` in the binary and protocol crates; `NoAnswer` distinguishes
  timeouts from stale-handle OS errors.
- Tests: `cargo test` must stay clean. Codec/protocol tests use captured or
  synthetic packets through a mock `Link`, never a live device. Hardware
  claims in docs must say which level of verification they have
  (code-verified / synthetic-tested / live-verified).
- Docs: protocol specs in `docs/` with a provenance note when adapted from
  upstream; vendor JS mirror in `docs/research/khub-webapp/` is read-only.
- Tag/value tables in `docs/protocol-*.md` carry a row for **unknown, seen
  on hardware** and keep the raw values. A table may only be called
  *complete* when a committed capture backs it — a table that claims
  completeness while missing a tag sends the next implementer straight
  into §Safety 7.

## Checks

Lean checks only — do not add heavy CI locally:

```sh
cargo build
cargo clippy
cargo test
npm --prefix web run build     # tsc + vite build
npm --prefix web run smoke
npm --prefix web test
```

`cargo fmt` is not enforced; match surrounding style. Windows-only CI is the
clean-checkout run.

## Incident log — khub916 cmd-8 stream wedge (2026-11)

`omg kb916 light stream` / `light music` send cmd-8 GIF frames
(fire-and-forget `feature_write`, 519 B reports). After many live runs —
including one interrupted mid-stream — the K1 Pro wedged: lighting stuck
off, **all Fn combos dead** (Fn+B/Tab/|/Shift), while normal typing and
Hub-web config writes still worked. Recovery required **two** resets:
`omg kb916 reset --yes` (cmd 17 type 0 = factory) then
`omg kb916 reset --kind 2 --yes` (reset all keymap layers), plus a
replug. Root cause unproven — consistent with firmware state corruption
from sustained/uninterrupted cmd-8 traffic or a killed restore; treat
cmd-8 as **hardware-unverified for long sessions**.

### Rules going forward (non-negotiable for cmd-8/GIF paths)

- **Never SIGKILL / force-quit** `light stream` or `light music`. The
  Ctrl-C handler must run to completion so profile + light-data restore.
  If a run is interrupted, expect the device may need `reset --yes`.
- **Snapshot sanity check before restore**: if the pre-stream profile
  shows an abnormal state (e.g. light mode 0/off while a stream was
  active, or a previous run was killed), do NOT blindly write it back —
  warn and let the user pick a known-good lighting config instead.
- **Rate-limit conservatively**: default 30 fps is the verified ceiling;
  do not raise `--fps` defaults or send back-to-back bursts without
  settle time. Vendor `setGifLight` cadence is ~30 ms.
- **Recovery commands** (both behind `--yes`, fire-and-forget, device
  reboots off the bus):
  - `omg kb916 reset --yes` — cmd 17 type 0, factory defaults.
  - `omg kb916 reset --kind 2 --yes` — reset all keymap layers.
  - `omg kb916 light apply <json> --yes` — restore a known-good
    lighting config (docs/lighting-schema.md).
- **Fn combos ARE protocol-visible** (corrected 2026-11-25): the Fn layer
  is keymap arg `0x01` and reads back normally. Before blaming firmware,
  read it (`omg kb916 keys --layer 1`) and check the affected slots. Live
  K1 Pro read showed slot 4 (L_Shift) and slot 79 (Backspace) as
  `0x00000000` while every other Fn key carried a tag-`0x08` action value —
  i.e. "Fn+Shift does nothing" is a **zeroed keymap slot**, not a wedge.
  `omg kb916 reset --yes` destroys these values; never use it to diagnose.
  Only after the Fn layer reads clean should a firmware wedge be suspected.
- **Tag `0x08` is undocumented** as of 2026-11-25. It appears on the whole
  Fn layer (`0x08020000`, `0x08030100`, `0x08030200`, `0x08040001`, …) but
  is missing from the tag table in `docs/protocol-khub916.md` §6 — where
  the decoder has no case for it, so it surfaces as `Unknown`. Until that
  tag is reversed and written down, Fn-layer values are **opaque**: per
  §Safety 7 they must be preserved byte-identical and must not be offered
  as editable in the remap UI.
- Any new always-on daemon or long-lived HID writer must install a
  signal handler that restores device state on SIGINT **and** SIGTERM,
  and must document what happens if it is killed ungracefully.
