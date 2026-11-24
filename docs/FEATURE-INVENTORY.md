# Feature Inventory

Every checklist from `docs/vision-full-custom.md`, annotated with **actual repo
state**. Status legend:

- `[shipped]` — implemented and (where applicable) live-verified; evidence cited.
- `[partial]` — implemented subset only; gap stated.
- `[missing]` — no code.
- `[blocked-by-hardware]` — code path exists or is spec'd, but cannot be
  verified without hardware we do not have.

Verification levels used throughout: **live-verified** (K1 Pro, 2026-11-24,
per `docs/protocol-khub916.md` §5 write log), **code-verified** (ported/
reversed, transport proven, no device), **code-tested** (unit/synthetic only),
**unverified** (spec exists, impl uncertain). The only device with
live-verified writes is the **K1 Pro over wired khub916**
(`VID 0x258A:0x010C`). HE v2, Compx mouse and SparkPlayJoy have **no hardware**;
everything below marked `[blocked-by-hardware]` for them is expected to be
code-tested only.

---

## A. Key remapping & keycodes (P0, 51 items)

### A1 — basic mapping (10)

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Remap any key | [shipped] | `omg kb916 set key/set keymap` (`crates/omg`); web keys page `web/src/remap.ts` |
| 2 | Unassign a key | [partial] | khub916 key values are u32 encodings; "unassign" = writing the unassigned value via `set key` — no dedicated UI affordance |
| 3 | Swap two keys | [missing] | no swap operation; manual two-step `set key` only |
| 4 | Copy/paste key binding | [missing] | — |
| 5 | Multi-select keys | [missing] | — |
| 6 | Drag & drop on visual keyboard | [missing] | `keyboard.ts` renders; no drag |
| 7 | Undo/redo (staged edits) | [partial] | staged-edit model exists in `remap.ts`; **no undo/redo stack** (bead `c8y`) |
| 8 | Reset key to default | [partial] | CLI `kb keys default r c` (HE only, `03 06`); khub916 has no per-key reset — whole-table rewrite only |
| 9 | Reset whole layer | [partial] | same as above; khub916 = full keymap file rewrite |
| 10 | Search key by name + HID usage | [missing] | key pool (`keypool.ts`) is a list; no search (bead `c8y`) |

### A2 — extended keycodes (15)

khub916 key values are a u32 firmware encoding decoded by
`decodeKeyValue`/`keyValueLabel` (`web/src/proto/khub916.ts`,
`crates/proto-khub916/src/lib.rs`). The 217-entry pool
(`web/src/keypool.ts`) covers the vendor's key set. Granular coverage of
the 15 sub-items (F1–F24, nav, numpad, L/R modifiers, media, volume/mute,
brightness, browser, power, consumer HID, mouse buttons/wheel, intl keys,
custom firmware codes) is **[partial]** — whatever the pool encodes is
shipped for khub916; HE v2 keycodes are code-tested only
(`crates/proto-he`, blacklist `0xF200/0xF203` enforced, `keycode_blacklisted`
`lib.rs:350`). Mouse buttons exist as *mouse* config
(`omg mouse set button`), not as keyboard-emitted keycodes.

### A3 — modifier combos (10)

All [missing] for keyboard output. There is no chord/combination engine in
any protocol crate. Closest existing primitive: khub916 MT/SOCD/TGL
advanced keys (`crates/proto-khub916/src/advkey.rs`, `web/src/advkeys.ts`) —
those are firmware-level tap behaviors, not host-side combos.

### A4 — key behavior (16)

| Sub-family | Status | Evidence |
|---|---|---|
| tap/hold, tap-hold threshold | [partial] | khub916 MT (Mod-Tap) via advkey cmd 18 — keymap binding ✅, history blob **does not persist on K1 Pro** (`docs/advkeys-schema.md`, README row "Advanced keys") |
| double/triple tap, tap dance | [missing] | no codec support found |
| long press | [partial] | same MT primitive |
| sticky / one-shot modifier or layer | [missing] | — |
| key repeat | [missing] | — |
| Caps Word, Grave Escape, Mod-Morph, Key Override | [missing] | — |

---

## B. Layers (20 items)

| Item group | Status | Evidence |
|---|---|---|
| 4 known layers, read + write | [shipped] | `kb916 keys --layer N --system N` (cmd 3/131), web `remap.ts` layer tabs |
| Create/rename/delete/clone layers | [missing] | firmware exposes exactly the layer slots in the u32 key encoding; no layer-management commands known (`docs/protocol-khub916.md` §6) |
| Import/export layers | [partial] | full keymap JSON lives inside `omg profile export` (schema v1) — no standalone layer file |
| Fn switching, MO/TG/TO/LT semantics | [partial] | layer bits are encoded in key values; explicit MO/TG/TO/LT op names not surfaced in UI |
| One-shot/sticky/conditional layers | [missing] | — |
| Activation indicator, priority/transparent key, conflict detector | [missing] | — |

Capability note: layer count is **firmware-fixed at 4** for khub916; HE v2
layer support is firmware-dependent and code-tested only.

## C. Advanced behaviors (14)

| Behavior | Status | Evidence |
|---|---|---|
| Mod-Tap (MT) | [partial] | codec + UI + keymap bind shipped; **history write unverified on K1 Pro** (`docs/advkeys-schema.md`, `crates/proto-khub916/src/advkey.rs`) |
| SOCD | [partial] | same caveat |
| TGL | [partial] | same caveat |
| Layer-Tap, Tap Dance, Combo, Key Override, One-Shot, Sticky, Caps Word, Auto Shift, Leader, Repeat, Mod-Morph, Conditional Layer | [missing] | no protocol evidence in any `docs/protocol-*.md` |
| Macro Behavior (as a key behavior) | [partial] | khub916 macros can be *bound to keys* via tag-3 binds (`omg kb916 macro bind`, `docs/macro-schema.md`) — live-verified write path; HE `kb macro` code-tested only |

## D. Combo & shortcut engine

[missing] — no combo detection anywhere (host-side or firmware-exposed).
HE `hk` advanced keys (`crates/proto-he`, `omg kb hk`) include DKS/MPT/SOCD/
RS modes but not arbitrary combos; code-tested only.

## E. Macro Studio (28 items)

| Item | Status | Evidence |
|---|---|---|
| Record from keyboard input | [missing] | no input-report capture in web; `crates` has no recorder |
| Record host keys / mouse | [missing] | — |
| Down/up, modifiers, delays | [shipped] | `delay:keycode[:up]` action grammar — `omg kb916 macro set`, `web/src/macro.ts` step editor, `docs/macro-schema.md` |
| Text sequences | [partial] | expressible as keycode sequences; no text→keys helper |
| Mouse move/wheel | [missing] | not in khub916 macro spec; Compx mouse macros are a separate flash feature (`omg mouse` config) — code-tested |
| Repeat N / ∞ | [missing] | macro region is a fixed ≤512 B action table (`docs/protocol-khub916.md` §6) |
| Nested macros | [missing] | — |
| Layer/combo triggers | [partial] | key *binds* exist (tag-3); layer triggers [missing] |
| Library, templates | [missing] | — |
| Import/export | [partial] | macro region hex rides inside `omg profile export --full`; no standalone macro file format |
| Duplicate | [missing] | — |
| Timeline preview, simulator | [missing] | bead `uol` covers timeline view |
| Validator (missing release, stuck modifier, overlong delay, storage overflow, unsupported keycode) | [missing] | `uol` |
| Storage usage display | [partial] | `kb916 macro list` shows region usage (≤512 B) |
| Undo/redo steps, search/replace, batch bind | [missing] | `uol` covers search/replace only |

khub916 macro read/write/bind/delete: **live-verified** on K1 Pro (README
checklist). HE `kb macro` (paged actions): code-tested only.

## F. Lighting Studio

### F1 — color (15)

| Item | Status | Evidence |
|---|---|---|
| Per-key RGB | [shipped] | `light-color`/`light apply`, cmd 134/6 + 138/10, live-verified (`docs/protocol-khub916.md` §6) |
| Global color | [partial] | single-colour modes via mode+color slots |
| Palette | [partial] | 8-colour palette concept exists in HE lighting (`kb light get` zones, code-tested); khub916 uses per-key RGB not palettes |
| Position/row/col gradients, rainbow | [shipped] | `light apply` JSON schema — `docs/lighting-schema.md`, `web/src/lighting.ts`, CLI `kb916 light apply` |
| Random | [missing] | — |
| HSV/RGB/HEX picker | [shipped] | `ColorPicker` in `web/src/lighting.ts:74` |
| Eyedropper | [missing] | — |
| Copy/paste color, history, favorites | [missing] | — |
| Presets | [partial] | lighting JSON presets via import/export file; no named preset store |
| Export/import | [shipped] | lighting JSON + `omg profile export` |

### F2 — effects (18)

| Item | Status | Evidence |
|---|---|---|
| 18 lighting modes | [shipped] | `LIGHT_MODES` table (`web/src/lighting.ts`), `omg kb916 set light-mode`, live-verified |
| Speed, brightness | [shipped] | mode params in cmd profile write |
| Static/breathing/wave…(named modes) | [shipped] | whatever the 18-mode table exposes — names in `model` crate / `lightModeInfo` |
| Custom animation / direction / intensity beyond mode params | [partial] | cmd-8 live RGB stream (`omg kb916 light stream`, `light music`) gives arbitrary frames — CLI only, live-verified; **no web UI yet** (bead `8r8`, in progress) |
| Per-effect speed/direction params | [partial] | speed+brightness exposed; direction/intensity not |

### F3 — advanced

| Item | Status | Evidence |
|---|---|---|
| Per-layer/state/CapsLock/game/profile/time/battery lighting | [missing] | firmware modes only; no conditional engine |
| Zones | [partial] | HE lighting areas (`kb lighting-areas`, 3 zones) — code-tested; khub916 = whole-keyboard |
| Per-key timeline | [missing] | — |
| Music/sound reactive | [partial] | `crates/music` + `omg kb916 light music` — **live-verified on K1 Pro**; web port in progress (bead `8r8`) |
| Named scenes save/load | [partial] | bead `nha` (localStorage scenes) |

## G. Analog / HE / Rapid Trigger — **HE devices only**

| Item | Status | Evidence |
|---|---|---|
| Actuation, RT, per-key actuation/RT | [blocked-by-hardware] | `omg kb perf get/set` (`crates/proto-he` cat 4) — code-tested |
| Press/release sensitivity, top/bottom deadzone | [blocked-by-hardware] | same |
| DKS, MPT, Mod-Tap, SOCD, snap-tap/LIP | [blocked-by-hardware] | `omg kb hk` advanced keys — code-tested |
| Analog output, travel monitor | [blocked-by-hardware] | `04 03` live travel (`omg kb live`); SparkPlayJoy 6×21 `omg kb travel-matrix` — code-verified transport, hardware pending (`docs/protocol-sparkplayjoy.md`) |
| Calibration | [blocked-by-hardware] | `omg kb calibration` — requires `--yes`, may be unverified read-back |
| Travel viz, per-key perf presets | [missing] in UI | no web UI at all for HE (bead `xp0`) |

**Must not appear for K1 Pro** — capability registry (bead `zlb`) does not
exist yet; today the web UI simply has no HE pages, but nothing *enforces*
hiding them.

## H. Device config (P1/P2)

| Item | Status | Evidence |
|---|---|---|
| Polling | [partial] | `omg kb polling get/set` (HE, code-tested); khub916 polling **unconfirmed** — no command known |
| Link status | [partial] | `omg mouse info` link type; `omg devices` enumeration |
| OS mode | [partial] | `omg kb os set` (HE) code-tested |
| Battery/charging | [shipped] | `kb916 power`, `omg mouse battery` (mouse code-tested) |
| Sleep timer | [shipped] | `kb916 set sleep`, `profile get`, web setting page — live-verified |
| Power saving | [partial] | sleep covers part of it |
| Debounce | [missing] | no protocol evidence |
| NKRO/6KRO | [missing] | — |
| Key repeat | [missing] | — |
| Switch/firmware/hw rev info | [shipped] | `kb916 info` (UUID, catalog model, firmware), `kb info`, `mouse fw` |
| Diagnostics | [partial] | `omg probe [--deep]` CLI exists; no web diagnostics page (bead `oq2`) |
| Latency / matrix / chatter / response / rollover tests | [missing] | — |
| Connection quality | [missing] | — |

## I. Layout editor (17 items)

| Item | Status | Evidence |
|---|---|---|
| Physical layout select (K1 Pro 87-key) | [shipped] | `web/src/k1pro-layout.ts` — physical geometry is hardware truth |
| ANSI/ISO/JIS, other models | [missing] | one layout only |
| Position/size/gap/rotation editing | [missing] | layout is fixed data, not editable |
| Hidden + virtual keys | [missing] | — |
| Custom legends | [missing] | labels come from `keyValueLabel` |
| Multi-layer view | [partial] | layer switch exists in `remap.ts`; no overlay compare |
| Pressed/selected highlight | [partial] | selected highlight yes; live pressed state no (no input reports read in web) |
| HID usage display | [partial] | decoded labels shown; raw HID usage not surfaced |
| Layout JSON import/export | [missing] | keymap JSON exists via profile; layout itself not portable |
| Validation, theme | [partial] | theme = vendor dark/lime CSS (`style.css`); no validation |

Physical vs visual vs mapping separation: **partially** — `k1pro-layout.ts`
is physical truth and `keypool.ts`/`remap.ts` is mapping, but there is no
separate editable *visual* layout layer.

## J. Profile / preset management (24 items)

| Item | Status | Evidence |
|---|---|---|
| Multi-profile CRUD, switch | [missing] | device has fixed profile blob (cmd 132/4); no profile slots known for khub916 |
| Per game/app/OS/user/work profiles | [missing] | — |
| Full + section backup/restore | [partial] | `omg profile export/import` schema v1 — HE/mouse only for import; **khub916 export-only** (`crates/omg/src/profile.rs`, README) |
| Compare, version history | [missing] | bead `th0` |
| Auto-snapshot before write | [missing] | CLI `profile import` does snapshot to `~/.local/share/oh-my-gravastar/backups/`; **web UI does not** — bead `sid`/`th0` |
| Import/export file | [shipped] | CLI + web config page (`snapshotToJson`, `pages-secondary.ts:97`) |
| Compatibility validation, migration | [partial] | import matches by protocol+VID/PID+usage page; **model-compat and range validation gaps = risk §4.2** (bead `y6s`) |
| Opt-in cloud sync | [missing] | — (offline-first; would need explicit opt-in design) |
| Template library | [missing] | — |

## Agent checklist (62 items, 6 categories)

Nothing exists yet — no `web/src/agent/`, no planner. Status by category:

| Category | Items | Status |
|---|---|---|
| Device intelligence (10) | enumerate, identify model/protocol/firmware, capability query, battery, link state, supported-feature list, version compat, diagnostics summary, explain device, health | [missing] — primitives exist (`omg devices --json`, `kb916 info`, `probe`) but no agent-facing assembly; "Explain my keyboard" = capability registry dump (bead `zlb` + `7js`) |
| Natural-language customization (10) | parse requests → keymap/lighting/macro/profile ops | [missing] — bead `7js` (P4, rule-based first) |
| Planning (10) | op list, diff preview, conflict detection, dependency ordering, dry-run, cost/impact estimate, rollback plan, capability check, multi-device plan, partial apply | [missing] — bead `ak2` covers schema+dry-run only |
| Execution (10) | approve gate, transaction, verify, journal, timeout/retry, abort, progress, partial-failure report, idempotency, audit | [missing] — CLI already does write→read-back verify + `--yes`; no journal/transaction layer (bead `sid`) |
| Learning/assistance (10) | presets, suggestions, unused-key analysis, layout generator, troubleshooting hints, migration help, profile generation, simulator | [missing] — all P2+ |
| Tools & interoperability (12) | CLI `--json`, WebHID transport, profile JSON schema, MCP/tool manifest, batch ops, scripting hooks, export formats, event stream, remote trigger (opt-in), SDK surface, docs for agents, versioned API | [partial] — CLI `--json` + profile schema v1 shipped; everything agent-facing [missing] |

## Safety levels L0–L4 (current enforcement)

| Level | Definition | Current state |
|---|---|---|
| L0 read-only | automatic | [shipped] — all reads need no flag; `omg probe`, web page loads |
| L1 draft/preview | automatic | [partial] — staged edits in `remap.ts`/`macro.ts` are drafts; `profile import --dry-run` exists (CLI); **no unified preview/diff** |
| L2 remap/lighting/macro | approval before write | [partial] — CLI: `--yes` + printed change + read-back verify (live-verified). Web: `window.confirm` dialogs (native — bead `sfa` replaces with styled modal showing diff/recoverability) |
| L3 polling/calibration | separate confirmation + impact | [partial] — CLI requires `--yes`; polling restart documented; **no dedicated impact-explanation UX**; calibration is HE-only code-tested |
| L4 factory reset/firmware/bootloader | never for agent | [shipped as omission] — blacklists enforced in `crates/proto-he/src/lib.rs:21`, `crates/proto-mouse/src/lib.rs:13,65` (`WRITABLE` ranges), `crates/proto-khub916/src/lib.rs:50`, `wireless.rs:26`; no code path exists |
