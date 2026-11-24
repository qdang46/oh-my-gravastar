# oh-my-gravastar — Plan

Agent-first, offline, open-source configurator for the whole GravaStar ecosystem
(keyboards + mice). Primary interface: a Rust CLI (`omg`) with `--json` on every
command so AI agents can drive it. Human-friendly TUI/web UI are later phases.

Upstream research lives in `../oh-my-gravastar-upstream/` (cloned 2026-11-24):
`orbit-gravastar` (Rust configurator, HE keyboard + Compx mouse protocols),
`mouse-protocol` (TS/WebHID codecs incl. GravaStar mouse), `OmaGravastar`
(Quickshell plugin + hidraw helper + protocol research dumps),
`HallJoy` (SparkPlayJoy 6x21 analog protocol, firmware static analysis),
`multilang-keycaps` (CadQuery keycaps, unrelated to protocol).

The vendor web app JS bundles are mirrored read-only in
`docs/research/khub-webapp/` for protocol reversing.

---

## 1. Device / protocol map (verified from upstream + vendor JS)

### 1a. Mercury K1 / K1 Pro / K98 Pro — mechanical, tri-mode (THIS USER'S KB)

- Web driver: `support.gravastar.com/1khub/` — "GravaStar Web HubX Pro",
  **WebHID** (Chrome/Edge/Opera only; no Bluetooth).
- The app is a **generic multi-brand keyboard SDK** (white-label): models
  include Kinesis, Redragon K80, F75/F87/F99, M80, A99PRO/A75PRO, M75/M75V2,
  RS75/RS108, LOYAL, SK88, and `916_K1` = "GravaStar Mercury K1".
- Every model has a `password` (device auth token, e.g. K1 =
  `0x0300000001b4`) and a `protocolKey` (`901`, `8815`, `916`; K1 series = `916`).
- Transport: WebHID, **feature reports** (`sendFeatureReport`), device chosen
  from collections having `outputReports>0 && featureReports>0` (or
  `outputReports>0 && inputReports>0`).
- Wired USB identity of K1 Pro: **VID `0x258A` (9610), PID `0x010C` (268)** —
  observed live on this machine; product string "Gaming Keyboard",
  manufacturer "BY Tech". Confirmed present in the app's device table
  (`916` list, `{vendorId:9610, productId:268}`).
- Wireless (2.4G dongle) identities: `916_wireLess` table — VID `0x3554`
  PID `0xFA09` (64009), VID `0x258A` PID `0x0150` (336), VID `0x379A`
  (14234) PIDs 40962/40969, etc.
- **Status: protocol not yet reversed.** The full driver JS is saved in
  `docs/research/khub-webapp/`; the HID engine lives in the obfuscated
  `index-M8-m9qFR.js` chunk (`sendFeatureReport` queue, string-table
  obfuscation `s(488)`-style). Reversing it is the main research task.
- K1 Pro capabilities per manual: 13 backlight effects, 5 ambient modes,
  key remapping, macros, profiles; hardware knobs for brightness.

### 1b. Mercury HE keyboards (V60/V75 Pro/V75/V75 Lite/K1 HE…)

Two **parallel** HID interfaces (both must be supported eventually):

- **v2 config protocol** — usage page `0xFFB0`, 64-byte reports
  `[category, command, args…]`, VIDs `0x1CA6`/`0x31E3`, 23 PIDs.
  Fully documented + implemented in `orbit-gravastar/src/protocol/keyboard.rs`
  and `docs/protocol-keyboard.md`. Categories: device(1), global(2),
  layout&keymap(3), performance(4), lighting(5), advanced keys(6),
  macros(7), fw update(8), custom(10), tri-mode(13).
  - `04 03` = live per-row travel readout (mm + actuated flag).
  - `03 05` = physical geometry (x/y/size) read from firmware.
  - Writes persist immediately; **no save/commit command**.
- **SparkPlayJoy 6x21 analog protocol** — usage page `0xFFA0:0001`,
  framed `5C <len> <cmd> <cksum> <payload>`, used by HallJoy for gamepad mode.
  Commands: sync `01`, travel scale `order 0x25`, default map `0x2B`,
  active function map `0x23`, live travel `0x12` (63 u16 samples/half,
  6x21 matrix, ~5µm resolution, max ~3.5mm).
  Proven on V75/V75 Pro/V75 Lite via firmware static analysis of
  `GravaStar75.exe`; HallJoy engine:
  `HallJoy/src/HallJoyProject/HallJoy/aula_win60he_protocol.{h,cpp}`,
  `aula_win60he_client.{h,cpp}`, identities in
  `sparklink_official_identities.h` / the 6x21 table.
  GravaStar board IDs: V75 `16052201` (VID:PID `1CA5:2201`),
  V75 Pro `16052202` (`1CA5:2202`), V75 Lite `2E022201` (`1CA2:2201`).
  V75 physical validation partially done (transport/board/map/scale/travel
  proven; sustained runtime pending).

### 1c. Mercury mice (M1/M2/X/X Air/X Pro…)

- Compx "Control Hub" chipset; VID `0x3554`, dongle PIDs
  `F54B F575 F548 F577`, wired `F576 F549`; HID page `0xFF02`, report `0x08`,
  16-byte payload `[cmd, status, addrHi, addrLo, len, data×10, cksum]`,
  checksum `(0x08 + Σbytes) & 0xFF == 0x55`.
- Flash-address settings map fully known (`orbit docs/protocol-mouse.md`,
  `mouse.rs`): polling, DPI stages+colors, LOD, buttons, lighting, macros,
  profiles (4), battery, firmware versions.
- mouse-protocol `drivers/gravastar/hid.ts` confirms same build as
  `bbb.pulsar.gg`; CID 18 = GravaStar, MID 1-2 PAW3395, MID 3-5 PAW3950.
- OmaGravastar adds export/import in web-driver `.bin` format + macro JSON.

---

## 2. Chosen product shape

```
oh-my-gravastar/                  # this repo
├── Cargo.toml                    # Rust workspace → single `omg` binary
├── src/
│   ├── main.rs                   # clap CLI
│   ├── hid/                      # hidapi link + transfer() (from orbit)
│   ├── proto/
│   │   ├── khub916.rs            # K1-series "916" feature-report protocol (NEW reverse)
│   │   ├── keyboard.rs           # HE v2 protocol port (from orbit)
│   │   ├── sparkplayjoy.rs       # 6x21 analog (port from HallJoy semantics)
│   │   └── mouse.rs              # Compx port (from orbit)
│   ├── model/                    # key labels, lighting mode tables, layouts
│   └── out/                      # --json serializers
├── docs/
│   ├── plan.md                   # this file
│   ├── protocol-*.md             # per-protocol specs (from upstream docs)
│   └── research/khub-webapp/     # vendor JS mirror (read-only reference)
└── tests/                        # captured-packet fixtures + mock Link
```

### CLI surface (agent-first)

Global: `--json` (default human text otherwise), `--device <path|vid:pid>`
(auto-pick if exactly one match), exit codes 0 ok / 1 error / 2 no device /
3 unsupported.

```
omg devices                          # list detected GravaStar devices
omg kb916 info|layout|keys|get|set … # K1 series (protocol 916)
omg kb info|layout|perf|light|…     # HE v2 protocol
omg kb travel <row>                  # live analog (SparkPlayJoy or 04 03)
omg mouse info|config|get|set …     # Compx mice
omg profile export|import <file>     # portable JSON profiles
omg probe                            # raw diagnostic dump (like orbit --probe)
```

### Safety contract (non-negotiable)

1. **Read-only by default.** Every write subcommand requires `--yes` and
   prints the exact change first; agents must opt in explicitly.
2. **Protocol-layer blacklist** — never implemented, even later:
   HE: `02 01` factory reset, `08 xx` firmware update, `0A 01 01 FF` wipe,
   `10 02` gamepad mode, `02 0F 01` restart, `02 09` default switch,
   categories `0x0C/0x0E/0x0F`.
   Mouse: `05/06` pairing, `09` factory reset, `31` RF channel,
   `B0–B7` bootloader range.
   khub916: anything not proven read-only until the reverse is documented.
3. **Write → read-back verify** on every mutation; report `verified: true/false`.
4. **Range validation** before send (actuation ≤ switch max travel, deadzone
   ≤ 1 mm, palette indices, etc.).
5. Mouse flash writes restricted to the known `WRITABLE` ranges (port of
   orbit's allowlist).
6. No credentials/tokens/serial numbers in logs or JSON output unless
   explicitly requested (`--include-serial`).

---

## 3. Feature decisions (chốt)

| # | Feature | Phase | Notes |
|---|---------|-------|-------|
| F1 | Rust CLI skeleton + hid link + `--json` output | P0 | clap, anyhow, hidapi, serde |
| F2 | HE v2 keyboard protocol (read+write) | P0 | port orbit `keyboard.rs`; verified on V60 Pro |
| F3 | HE keyboard CLI (info/layout/perf/light/polling/profiles) | P0 | covers V60/V75 series |
| F4 | Compx mouse protocol + CLI | P1 | port orbit `mouse.rs`; covers M/X series |
| F5 | khub916 protocol reverse + K1/K98 support | P0 | **main differentiator**; JS reference saved |
| F6 | SparkPlayJoy 6x21 analog reader | P1 | travel matrix → JSON stream; basis for future TUI/gamepad |
| F7 | Profile export/import (JSON schema v1) | P1 | kb+mouse unified; mouse `.bin` compat optional later |
| F8 | `omg probe` raw diagnostic | P1 | needed for adding new models safely |
| F9 | TUI (ratatui) | P2 | optional human UI over same core |
| F10 | Web UI (offline PWA/WebHID) | P3 | only if demand; protocol layer is transport-agnostic by design |
| F11 | macOS hidapi quirks / permissions doc | P0 | user is on macOS; document IOHIDManager access |
| F12 | CI: unit tests w/ captured packets, fuzz decode paths | P0 | orbit has packet tests to port |

Deferred / rejected for now: firmware flashing (never), bootloader commands,
web driver emulation, mouse macros/shortcuts editing (P2), K98 Pro screen
(GIF editor — big, P3), i18n (English first, CLI strings easy to add).

---

## 4. Milestones

- **M0 — skeleton**: cargo project builds, `omg devices` lists the connected
  K1 Pro (VID 0x258A PID 0x010C) and any HE/mouse devices; `--json` works.
- **M1 — khub916 reverse**: deobfuscate `index-M8-m9qFR.js` HID engine enough to
  enumerate commands; implement auth handshake (password `0x0300000001b4`
  for K1) + read-only info/layout/lighting; verify against the live K1 Pro.
- **M2 — HE keyboard CLI**: port + unit tests; user-verifiable on any HE board.
- **M3 — mouse CLI**: port + tests.
- **M4 — profiles + probe + docs**: export/import, README, protocol docs,
  AGENTS.md with safety rules.
- **M5 — SparkPlayJoy analog**: 6x21 travel stream (needs HE board to verify).

Hardware available NOW: K1 Pro (wired, VID 0x258A:0x010C) → M0/M1 verifiable
today. HE keyboard + mouse verification pending user hardware.

---

## 5. Open questions / risks

- khub916 protocol is obfuscated JS; reversing effort uncertain. Mitigation:
  the app is a generic SDK used by many brands — community may have notes;
  also `password` + `protocolKey` structure suggests a documented-ish
  request/response envelope worth extracting first.
- K1 Pro over **2.4G dongle** uses different PIDs — support wired first.
- WebHID feature-report semantics vs hidapi: `sendFeatureReport` maps to
  hidapi `write` on the feature report ID (or `send_feature_report`); needs
  a probe to confirm report ID and direction on macOS.
- GravaStar trademarks: README/docs must state non-affiliation (same as orbit).
