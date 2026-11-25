# OS-profile / semantic key mapping — feasibility per device family

Research note for the design-review gap "semantic key remapping like macOS
`Cmd+C` needs OS-profile semantics". Date: 2026-11 (branch
`agent-config-platform-r2`). Companion: `docs/protocol-behaviors.md`
(combo/behavior verdicts), `docs/specs/schema-coverage-and-reset-decision.md`
§2.1/§5, `docs/specs/rust-cli-config-migration-spec.md` §7.

Verification levels: **live-verified** (K1 Pro on hardware) /
**code-verified** (vendor JS or traces) / **code-tested** (synthetic only) /
**unverified** / **unsupported**.

Headline: **no supported family can express a true "press X → emit
OS-semantic chord" binding today.** khub916 can emit a *static chord
output* (one u32 = modifier bitmask + one HID usage, e.g. LWin+C) but has
only one GUI bit — it cannot distinguish Cmd from Win. HE v2 has a real
firmware OS-mode setting (`omg kb os`) but its keymap is one u16 keycode
per key with no chord encoding. Compx mouse and SparkPlayJoy have no key
semantics at all. Host-side remap (a daemon intercepting keystrokes) does
not exist in this project and is out of scope of the config-apply
architecture.

---

## 1. khub916 wired (K1 / K1 Pro / K1 Lite / K98)

### 1.1 What the u32 key value can express [code-verified + live-verified]

`crates/proto-khub916/src/lib.rs::decode_key_value` (lines 387–413) decodes
tag = bits 31..24:

| tag | variant | payload |
|---|---|---|
| `0x00` | `Normal` | `(modifier_bits << 16) \| HID_usage` — lib.rs:392–398 |
| `0x03` | `Macro` | type/number/index bytes |
| `0x07` | `SecondaryLayer` | raw (semantics unconfirmed) |
| `0x08` | *(no case)* | firmware-internal Fn-layer code — opaque, §Safety 7 |
| `0x0D` | `Fn` | layer byte |
| `0x20/0x21/0x22` | `Socd`/`Mt`/`Tgl` | adv-key bindings |

For tag 0 the modifier field is a 4-bit mask at bits 16–19:

```
bit16 = Ctrl (0x00010000)   bit17 = Shift (0x00020000)
bit18 = Alt  (0x00040000)   bit19 = GUI  (0x00080000)
```

`KeyValue::Normal.label()` renders the GUI bit as **"Win"** (lib.rs:426–453).
`usage == 0` with modifier bits = bare modifier key (live-observed,
lib.rs:439–447). Dual encodings exist (`0x00800007` and `0x80000007` both
decode as LWin+D — `docs/protocol-khub916.md` §6 "Key value encoding").

**Critical limitation: there is exactly ONE GUI bit.** The encoding cannot
distinguish Windows-Super from macOS-Command. "Meta+C" is expressible only
as "Win+C" (`0x00080000 | 0x06`); whether the OS interprets that as Cmd
depends entirely on host-side key mapping, which the device does not
control per-key.

### 1.2 Vendor "combo key" — chord *output*, not combo *trigger*

`docs/protocol-behaviors.md` §1.3 documents vendor `setKeyboardComboKey`:
it builds `value = ((keyA.mods | keyB.mods) << 16) | keyC` and writes it via
cmd 3 — **the same tag-0 shape as a normal multi-modifier key**. The
vendor legend pool (`Ca`, 868 entries) literally ships assignable names
like `LWin + D`, `LWin + A`, `LWin + X`, `LWin + Ctrl + Enter`,
`Ctrl + Shift + Esc`, `Alt + Tab`, `Alt + F4` (visible in
`docs/research/khub-webapp/index-M8-m9qFR.deob.js` pool dump and
`docs/protocol-khub916.md` §6). So the firmware *does* emit multi-modifier
chords from a single key slot — but always the Windows-centric modifier
set (Ctrl/Shift/Alt/Win). There is no per-OS modifier remap inside the
value encoding.

### 1.3 The actual OS mechanism on khub916: dual keymap banks

The keymap `arg` byte is `layer & 3 | (system & 1) << 2`
(`crates/proto-khub916/src/lib.rs:729–731, 852–853`;
`docs/protocol-khub916.md:257`) → **4 layers × 2 system variants = 8 banks**
(cmds 131 read / 3 write). The `system` bit is the vendor's
**`systemModel` Win/Mac selector** (`web/src/keymap-guard.ts:126–131`),
i.e. the firmware keeps a second key table per layer for the other OS
layout (presumably swapping e.g. Alt/GUI positions or emitting Cmd-position
usages).

Honest status of this mechanism:

- **Code-verified only, and currently distrusted.** Live reads of args
  4–7 on the K1 Pro return a differently-framed/byte-rotated payload, so
  the web UI locks them: `SYSTEM_KEYMAP_ARGS_TRUSTED = false`,
  `SYSTEM_ARG_LOCK_REASON` ("the keyboard does not return a readable key
  table for the system-variant key sets") —
  `web/src/keymap-guard.ts:134–151`.
- **No verified command selects or queries the active bank.** The only
  OS-ish byte is `profile[1]` = "system/layout byte (used by
  `getKeyboardSystem` in **siblings**)" — `docs/protocol-khub916.md:431`.
  Whether the wired `Ht` class exposes it, and whether the firmware picks
  the bank by host OS or by that profile byte, is **unverified**.
- **No `os_mode` capability exists** for `Khub916Wired` in
  `crates/omg/src/device.rs:68–95` (verified: grep for `os`/`system` in
  `crates/proto-khub916/src` finds only the keymap-arg packing — there is
  no OS-mode command). `omg kb916` has no `os` subcommand
  (`crates/omg/src/main.rs:4141–4168`).

**Verdict (khub916):** firmware *can* express a static chord output
(`{mods:[gui], key:c}` → `0x00080006`) — code-verified, live-verified
write path for tag-0 values — but it is Windows-semantic only (one GUI
bit, labelled "Win"), and the dual-bank OS profile that would make it
Mac-correct is **unproven end-to-end** (unreadable bank + no verified
bank-select command). Do not claim `meta+c` support.

---

## 2. HE v2 keyboard (`omg kb`, `0xFFB0`)

### 2.1 Real firmware OS mode exists [code-tested]

`crates/proto-he/src/lib.rs:907–914`:

```rust
/// 0 = Windows, 1 = macOS.
pub fn system(&mut self) -> Result<u8> { ... [GLOBAL, SYSTEM, READ] ... }
pub fn set_system(&mut self, value: u8) -> Result<()> { ... WRITE ... }
```

Wire form: category `GLOBAL = 2` (lib.rs:52), sub-command `SYSTEM = 4`
(lib.rs:60) → `02 04 01` read / `02 04 02 v` write;
`docs/protocol-he-v2.md:52` marks it ✔ (code-verified read/write). CLI:
`omg kb os get|set` (`crates/omg/src/main.rs:2272–2315`), read-back
verified, `--yes` gated. Capability: `device.rs:123` `os_mode:
supported:true, code-tested`. **Everything here is code-tested —
hardware-unverified** (no HE board attached; `docs/protocol-he-v2.md:90`).

Related: keycodes `0xF201` "Win layout" / `0xF202` "Mac layout" exist as
**long-press** triggers (`docs/protocol-behaviors.md:151–154`) — i.e. the
firmware has per-OS layout variants, consistent with OS mode selecting
which modifier/HID layout is emitted. The exact report-level effect of
`02 04 02` (does it swap GUI↔Alt positions? change the GUI usage? remap
keycap legends only?) is **unverified** — inferred from vendor driver,
not observed.

### 2.2 Can HE express `meta+c`? No — as a *binding*, no; as *keys*, trivially

HE keymap = **one u16 keycode per physical key** (`03 01/02/03/04`,
`crates/proto-he/src/lib.rs:818–849`). `0x00xx` = HID usage, so modifiers
are ordinary keys (0xE0–0xE7) on their own slots. There is:

- no modifier-bitmask field in a keymap value (unlike khub916 tag 0),
- no chord/macro-trigger encoding in the keymap (HigherKey modes emit
  single u16 keycodes; macros are stored sequences, not press-triggers —
  `docs/protocol-behaviors.md` §2 verdict table: **Combo = unsupported**).

So "press key X → send Cmd+C" is **not firmware-expressible** on HE.
What IS expressible: put the GUI-position key and `c` on two slots (a
user chord), or rely on OS mode + the physical Cmd/Win key. Semantic
"meta+c" as a *named action* only works if the schema resolves `meta` to
the OS-appropriate modifier per `device.os_mode` and emits two key
assignments — which is layout advice, not a device binding.

---

## 3. Compx mouse — N/A

`docs/protocol-compx-mouse.md:98–103`: six button slots, `type` 0 disabled
/ 1 mouse button / 2 DPI cycle / **5 shortcut / 6 macro**; shortcut records
at `256 + 32·i`, macros at `768 + 384·i` in flash. `Button` in
`crates/proto-mouse/src/lib.rs:206–211` exposes only `{kind, param}` —
shortcut/macro payload semantics are undecoded. `docs/protocol-behaviors.md`
§3: *"Every inventory behavior: unsupported"* — no timing/threshold/layer
parameters exist in the 189-byte settings map. **No key semantics → no OS
profile concept. Reject all semantic key actions for this family.**

## 4. SparkPlayJoy 6×21 — N/A (read-only)

`docs/protocol-sparkplayjoy.md`: strictly read-only (identity, travel
scale, physical map, Fn0 function map, live travel). No write path exists;
`docs/protocol-behaviors.md` §4: every behavior unsupported/unwritable.

khub916 **wireless** (`916_wireLess`): shares the keymap u32 encoding but
the transport is not implemented in `omg` (`device.rs:104–109`,
`protocol-khub916.md` §7); wireless cmd-6 reset is blacklisted
(`proto-khub916/src/lib.rs:50–54`). Treat OS semantics as identical to
wired *if* ever implemented, pending the same bank-read problem.

---

## 5. Host-side remap — the only true `Cmd+C` path, and it does not exist

macOS-style semantic remapping ("press this key → emit Cmd+C regardless
of layout") requires intercepting input events in the OS — a daemon /
keyboard driver / input-method layer. This project has:

- no daemon (CLI is one-shot; `omg plan`/`config apply` are transactional
  writers, not resident processes),
- no input-tap or HID-remap capability in any crate (checked:
  `crates/hid` is open/write/query only; `crates/proto-*` encode device
  config, not host input),
- the web PWA is a WebHID *device* client, not an input interceptor.

Per `docs/specs/rust-cli-config-migration-spec.md` §3.2, runtime/streaming
surfaces are deliberately kept separate from config apply; a host-remap
daemon would be a new product surface, not a config-schema field. **Out of
scope; do not design schema fields that imply it.**

## 6. Proposed semantic-action schema shape

Keep raw values canonical (per schema-coverage §2.1: "Preserve raw
integer/hex representation; decode labels are presentation metadata") and
add an optional *presentation/authoring* layer that compiles to raw
values — never the reverse.

```jsonc
// khub916 keymap slot — authoring form (compiles to one u32)
{ "kind": "chord",
  "modifiers": ["gui", "ctrl"],        // subset of ctrl|shift|alt|gui
  "key": "c" }                          // HID usage name or "0xNN"
// rejects: modifiers outside the 4-bit mask; "meta"/"cmd"/"super" aliases
//   UNLESS resolved per target.os_profile; tag-8 / unknown / tag-7 slots
//   must be rejected as *authored* values (they remain opaque on read)

// HE v2 keymap cell — single keycode only
{ "kind": "key", "keycode": "0x06" }    // or HID usage name
// rejects: any "chord"/"modifiers" field — no wire encoding exists
```

Rules per family:

| family | accept `chord` | accept `combo` trigger | accept `os_profile` field |
|---|---|---|---|
| khub916 wired | yes → tag-0 u32 (gui bit = Win semantics only) | no (vendor "combo key" is the same chord output) | only as *informational* target of the unproven dual-bank system; never auto-select |
| HE v2 | no | no | yes → maps to `device.os_mode` ∈ {windows, macos} (code-tested) |
| Compx mouse | no | no | no |
| SparkPlayJoy | no (read-only) | no | no |

`meta`/`cmd`/`super` aliases: resolve `meta`→`gui` only when the schema
declares the target OS profile; on khub916 the emitted bit is still the
single GUI bit (labelled "Win" — lib.rs:433), so a `meta`→`gui` mapping is
a *host-interpretation* claim, not a firmware guarantee. Mark such fields
`verification: code-verified` at best on khub916, `code-tested` on HE.

---

## 7. Evidence index

- `crates/proto-khub916/src/lib.rs:387–413` tag decode; `:426–453` labels
  ("Win" for GUI bit); `:729–746, 852–899` keymap arg packing + write.
- `docs/protocol-khub916.md:257` arg formula; `:281–305` key-value
  encoding; `:431` profile[1] system byte (siblings only); `:299–341`
  tag-0x08 opacity.
- `web/src/keymap-guard.ts:126–151` — system bit = vendor `systemModel`
  Win/Mac selector; args 4–7 reads garbled, edits locked.
- `docs/protocol-behaviors.md` §1.3 (vendor combo = static chord output),
  §2 verdict table (HE: no combo), §3 (mouse: nothing), §4 (SparkPlayJoy:
  read-only).
- `crates/proto-he/src/lib.rs:52,60,907–914` OS-mode command;
  `docs/protocol-he-v2.md:52`; `crates/omg/src/main.rs:2272–2315` CLI;
  `crates/omg/src/device.rs:123` capability (code-tested).
- `docs/research/khub-webapp/index-M8-m9qFR.deob.js` — vendor legend pool
  chord names (`LWin + D`, `Ctrl + Shift + Esc`, …).
