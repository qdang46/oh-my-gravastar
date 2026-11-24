# AGENTS.md — oh-my-gravastar working rules

Read `docs/plan.md` first; it is the source of truth for scope, protocols and
milestones. Upstream reference code: `../oh-my-gravastar-upstream/`
(`orbit-gravastar` Rust, MIT — port logic, never copy egui/UI code).

## Safety contract (non-negotiable, from plan.md §2)

1. **Read-only by default.** Every write subcommand requires `--yes` and
   prints the exact change first.
2. **Protocol-layer blacklist — never implement, even later:**
   - HE keyboard: `02 01` factory reset, `08 xx` firmware update,
     `0A 01 01 FF` wipe, `10 02` gamepad mode, `02 0F 01` restart,
     `02 09` default switch, categories `0x0C/0x0E/0x0F`.
   - Compx mouse: `05/06` pairing, `09` factory reset, `31` RF channel,
     `B0–B7` bootloader range.
   - khub916: nothing until the reverse is documented and proven read-only.
3. **Write → read-back verify** on every mutation; report `verified`.
4. **Range validation** before send (actuation ≤ switch max travel, deadzone
   ≤ 1 mm, palette indices, mouse `WRITABLE` flash ranges only).
5. No credentials/tokens/serial numbers in logs or JSON unless
   `--include-serial` is passed.

## Conventions

- Cargo workspace under `crates/`; the binary is `crates/omg` (`omg`).
- Transport lives in `omg-hid` (`Link`, `HidLink`, `transfer`, `NoAnswer`,
  `find_devices`/`classify` identity tables). Protocol crates depend on it;
  it must never send protocol commands.
- Every command that emits data supports `--json`. Exit codes:
  0 ok / 1 error / 2 no device / 3 unsupported.
- New device identities go into `crates/hid/src/devices.rs` tables with a
  comment citing the source (official driver table or upstream constant).
- Lean checks: `cargo build`, `cargo clippy`, `cargo test` must stay clean.
- Docs: protocol specs in `docs/`, vendor JS mirror in
  `docs/research/khub-webapp/` is read-only reference.
