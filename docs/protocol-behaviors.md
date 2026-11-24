# Advanced key behaviors — what each protocol can actually express

Research note for bead `oh-my-gravastar-0is`. Maps the vision inventory
(`docs/vision-full-custom.md` §C/D, `docs/FEATURE-INVENTORY.md`) onto
protocol-level evidence. Verdicts:

- **supported** — a wire-level mechanism exists (opcode/tag/mode cited).
- **unsupported** — evidence of absence: the vendor driver exposes no such
  feature and no spare tag/mode/region exists to carry it.
- **unknown** — a plausible encoding slot exists but its semantics are
  unconfirmed; needs hardware or more reversing.

Verification levels follow the house convention: *code-verified* (reversed
from vendor JS / ported), *live-verified* (K1 Pro, 2026-11-24),
*code-tested* (synthetic only), *hardware-unverified*.

---

## 1. khub916 (GravaStar Mercury K1 / K1 Pro / K98 Pro) — wired + wireless

### 1.1 Keymap value tag space (u32 BE, bits 31..24)

Keymap value tags recovered from the vendor decoder `be()`
(`docs/research/khub-webapp/index-M8-m9qFR.deob.js`, ~offset 26248) and
`crates/proto-khub916/src/lib.rs::decode_key_value` (lines 384–410).
**Not complete** — see the `0x08` row.

| tag (bits 31..24) | vendor name | meaning | evidence |
|---|---|---|---|
| `0x00` | — (normal / "CB") | `(modifier_bits << 16) \| HID_usage`; also encodes **combo chords** and mouse/media keys | `protocol-khub916.md` §6 "Key value encoding"; decoder `case 0` marks known chord values `type:"CB"` |
| `0x03` | `M` | macro reference: bits 23..16 type `h`, 15..8 number `x`, 7..0 index `v` → `"0x03"+h+x+v` | decoder `case 3`; `macroIndex` extraction in `getKeyBoardMacroIndex` |
| `0x07` | `S` | "secondary-layer key" — shown only when the system arg ≠ 0; **semantics unconfirmed** | decoder `case 7: a!=0 && (u="S")`; `KeyValue::SecondaryLayer` (`lib.rs:363`) |
| `0x08` | — | **unknown, seen on hardware.** Dominates the K1 Pro Fn layer (arg `0x01`): `0x08020000` Tab, `0x08030100` F6/Up, `0x08030200` F5/Down, `0x08030201` `>.`, `0x08040001` `<,`, `0x08040100` Right, `0x08040200` Left, `0x08000000` `\|`, `0x08000001` R_Shift. Bit layout unproven — the `0x08 02/03/04` and low-byte patterns suggest rows, not HID usages | live read 2026-11-25 (`omg kb916 keys --layer 1`); no `case 8` in vendor decoder `be()`, no entry in the `Ca` pool |
| `0x0D` | — | Fn layer key: bits 23..16 = layer (`0x0D000000`=Fn, `0x0D010000`=Fn1) | decoder `case` via `0x0D`; `lib.rs:353`; live keymap read slot 0 = `0x00000029`… `0x0D…` rows |
| `0x20` | `SOCD` | SOCD adv-key binding (slot index bits 16..23 + direction param) | decoder `case 32`; `advkey.rs:63` |
| `0x21` | `MT` | Mod-Tap / hold-tap binding (+ `time` in low 16 bits, 10 ms units) | decoder `case 33`; `advkey.rs:64` |
| `0x22` | `TGL` | toggle/continuous-trigger binding | decoder `case 34`; `advkey.rs:65` |
| other | — | `KeyValue::Unknown`, kept verbatim | `lib.rs:378` |

Per AGENTS.md §Safety 7, `0x08` slots are opaque: preserve byte-identical,
do not expose them as editable, and do not default them to 0 in any
read-modify-write.

The vendor UI's advanced-key page (`AdvancedKey-YMbKTFT4.js`,
`index-cV1Bl4gC.js` `keyModel` list id 1–4) exposes **exactly four**
behaviors: SOCD, MT, TGL, and "combo key" (`advancedKey.comboKey`). There is
no UI path — and therefore no known wire encoding — for tap dance, one-shot,
sticky (beyond TGL), caps word, auto shift, leader, repeat, mod-morph, key
override, or conditional layers.

Adv-key bindings require a paired **history blob** write: 512 B =
SOCD 200 B (8 B slots: keyA u32 + keyB u32) + MT 200 B (8 B slots:
tap u32 + hold u32) + TGL 112 B (4 B slots: target u32) — wired cmd 18,
wireless chunked cmd 18 (`docs/advkeys-schema.md`,
`docs/protocol-khub916.md` §6/§7). Binding values are
`kind_base + (nonzero_slot_groups−1)*0x10000 + params`.

**Caveat (live-observed):** on the K1 Pro the cmd-18 history write is
byte-identical to the vendor's and accepted, but did **not persist**
(fresh-session cmd-146 reads returned the old blob); in-session reads
returned unrelated firmware pages for ~60 s. Possibly this firmware lacks
adv-key storage or needs an unidentified vendor-session step
(`docs/advkeys-schema.md` "Known limitations"). All MT/SOCD/TGL verdicts
below are therefore *code-verified, persistence unconfirmed on K1 Pro*.

### 1.2 Layers

- Keymap arg = `layer & 3 | (system & 1) << 2` → up to 4 layer slots × 2
  system layouts (`lib.rs:837–859`). Vendor UI exposes three editable maps
  per system: `defaultLayer` / `fnLayer` / `fn1Layer`
  (`index.js` `basicChangeKeyCode` strings; `keyData.{normal,fn,fn1}`).
- Layer switching = dedicated key values: `0x0D000000` Fn, `0x0D010000`
  Fn1. Whether these are momentary (hold) or latching is **not documented
  anywhere** → layer-tap semantics unknown.
- Tag `0x07` "S" (secondary layer) exists in the decoder but its write
  path was never observed in the vendor JS → unknown.

### 1.3 "Combo key" — important distinction

Vendor `setKeyboardComboKey` (`index-M8-m9qFR.deob.js` ~offset 179356):

```js
value = ((keyA.value >> 16 | (keyB ? keyB.value >> 16 : 0)) << 16) | keyC
// bound to physical slot a.CBKey.pos via setKeyboardKeys (cmd 3)
```

UI string (`index.js`): *"Trigger multiple modifiers combined with a
single regular key to form a combo command"* / *"一键触发多个修饰符与单个
常规按键组合成组合指令"*. The result is a **tag-0 u32 identical in shape
to a normal multi-modifier key** — i.e. the bound key statically emits
`mods(A)+mods(B)+keyC`. There is **no multi-key press detection, no
timeout, no output≠input remapping**: it is a chord *output*, not a combo
*trigger*. The decoder's `type:"CB"` is only a display hint for values in
a hardcoded known-chord list.

### 1.4 Verdict table — khub916

| Inventory behavior | Verdict | Evidence |
|---|---|---|
| Mod-Tap | **supported** (persistence unconfirmed) | tag `0x21` binding + MT history slot `[tap u32, hold u32]` + `time` (10 ms units, UI "按住时间"); vendor UI "按住/单击(MT)"; `advkey.rs`, cmd 3+18 |
| Tap-Hold | **supported** (same mechanism) | identical to Mod-Tap — MT *is* the hold/tap primitive |
| Layer-Tap | **unknown** | tag `0x07` "S" secondary-layer key exists but write path/semantics unobserved; Fn/Fn1 (`0x0D`) are layer-switch keys whose hold-vs-toggle semantics are undocumented |
| Tap Dance | **unsupported** | no tag, no history region, no UI; vendor advanced-key list = SOCD/MT/TGL/Combo only |
| Combo (press A+B… → output) | **unsupported** | vendor "combo key" is a static chord output (tag-0, no history, no detection); see §1.3 |
| Key Override | **unsupported** | no tag/history for press-time remapping; only static per-slot values |
| One-Shot | **unsupported** | no encoding; TGL is toggle (see Sticky), not one-shot |
| Sticky (modifier/layer) | **supported** (inferred, persistence unconfirmed) | TGL tag `0x22` + 4 B history slot holding one u32 = "tap toggles continuous triggering of the stored value; hold = normal" (vendor `tglDescription`). A stored modifier value plausibly yields sticky-modifier; stored layer-ish value → sticky layer. Semantics inferred from UI text, not proven |
| Caps Word | **unsupported** | — |
| Auto Shift | **unsupported** | — |
| Leader Key | **unsupported** | — |
| Repeat Key | **unsupported** | — |
| Mod-Morph | **unsupported** | no encoding for modifier-set morphing |
| Conditional Layer | **unsupported** | layers are fixed slots; no condition engine |
| Macro as key behavior | **supported** | tag `0x03` macro refs (type/number/index) bound via cmd 3; macro region cmd 5/133 ≤512 B — **live-verified** write+read-back on K1 Pro |
| (extra) SOCD | **supported** (persistence unconfirmed) | tag `0x20`, 8 B history slots `[keyA,keyB]`, direction 0–3 (last-input/abs-A/abs-B/all-cancel); `advkey.rs`, cmd 3+18 |

---

## 2. HE v2 (GravaStar Mercury HE — V60/V75 family, `0xFFB0`)

Behavior engine = **category 6 HigherKey**, one mode byte per key
(`[6, op, row, col, mode]`, op 1 read / 2 write). Ported in
`crates/proto-he/src/lib.rs:162–333`; wire layouts from
`docs/research/he-macros-research.md` §"Category 6" — **hardware-unverified**.

Mode semantics from the vendor v2 driver locale strings
(`docs/research/he-webapp/v2/index-BEtzL_HV.js` ~offset 533068,
`advancedKey1..8`):

| mode | vendor label | parameters | inventory mapping |
|---|---|---|---|
| 0 NONE | — | — | clear |
| 1 DKS | "动态键程" — *a single key can perform four functions based on four different actions* | `kcs[4]` u16 + `trps[4]` u8 trigger points + `dbs[2]` µm | **HE-only analog behavior** — 4 outputs at 4 press depths; no inventory equivalent (closest: nothing; it is press-position layer switching) |
| 2 MPT | *a single key can trigger three different keys at three different press depths* | `kcs[3]` u16 + `dbs[3]` µm | **HE-only analog behavior** — 3 depth-zone outputs |
| 3 MT | *holding and tapping the key produce different functions* | `kcs[2]` u16 + `time` u16 | **Mod-Tap / Tap-Hold** ✔ |
| 4 TGL | *tapping the key initiates continuous triggering* | `kcs` u16 + `time` u16 | **Sticky/Toggle** — tap toggles a held output; closest to Sticky/One-Shot family |
| 5 END | *a single key can send a different key upon release* | `kcs[2]` u16 + `delay` u16 | partial **Key-Override** analogue — alternate output fires on release, not a press-time remap |
| 6 SOCD | two-key opposing pair, `socdMode` directions Cover/PriorityA/PriorityB/Neutral | two cross-linked packets, `kcs[2]` + `delay` + dir pair | **SOCD** ✔ (not in C list but relevant) |
| 7 RS | *monitors two keys; the deeper press wins, but a full press on both triggers them all* | two cross-linked packets, `kcs[2]` + `delay` | **SOCD-family / analog priority** — HE-only variant |

Layers: `03 01/02/04 layer row col` with `layer` 0–3 → **4 layers**
(`fn0`–`fn3` in the driver store). Layer switching is via dedicated
keycodes `0xF100`–`0xF103` = "Fn0 切换主层 / Fn1..Fn3 切换FnN层"
(vendor keycode table, `index-Bd5dQyX3.js` ~offset 1108869). Whether these
are momentary or latching is undocumented → **Layer-Tap = unknown**; there
is no MO/LT-style keycode in the table (checked all `0xF1xx`/`0xF2xx`/
`0xF3xx`/`0xF5xx` entries: Fn layers, Reset/Win/Mac/Adj long-press,
Config1–4 profile switch `0xF205–0xF208`, LockWin `0xF209`, lighting
`0xF300+`, tri-mode `0xF4xx`, macros `0xF500+`).

Other keycodes: `0xF200` Reset, `0xF201` Win layout, `0xF202` Mac layout,
`0xF203` Adj (calibration) — all **long-press** triggers (vendor `comm`
strings "长按生效"); `0xF205–0xF208` Config1–4 = hardware profile switching
(a firmware-level "conditional profile", not a layer condition).

Category 7 Macro: per-slot `repNum`/`mode` (4 UI modes: repeat/single/
quick/…) + paged action list (15 u32 actions/page) → **macro behavior
supported** (code-tested only).

### 2.1 Verdict table — HE v2

| Inventory behavior | Verdict | Evidence |
|---|---|---|
| Mod-Tap | **supported** (hw-unverified) | HK mode 3 MT: `kcs[2]`+`time`; `proto-he` `MtParams`, `hk set` |
| Tap-Hold | **supported** (same) | identical primitive |
| Layer-Tap | **unknown** | 4 layers exist (`0xF100–0xF103` switch keys) but hold-vs-toggle semantics undocumented; no LT keycode found |
| Tap Dance | **unsupported** | no HigherKey mode for it (8 modes enumerated exhaustively) |
| Combo | **unsupported** | SOCD/RS are strictly two-key pairs; no N-key combo mode |
| Key Override | **partial → unsupported as specced** | END mode = different key *on release*; no press-time override/remap-beyond-keycode (keymap itself is per-layer static) |
| One-Shot | **unknown/partial** | TGL = tap→continuous trigger; whether it auto-releases (one-shot) vs latches (sticky) is undocumented |
| Sticky | **supported** (inferred) | TGL mode 4 — "tap initiates continuous triggering" |
| Caps Word / Auto Shift / Leader / Repeat / Mod-Morph / Conditional Layer | **unsupported** | no mode/keycode/category for any of them |
| Macro behavior | **supported** (code-tested) | cat 7 `07 01–04`, `repNum`, 4 macro modes |
| (extras) DKS / MPT / SOCD / RS | **supported** (hw-unverified) | modes 1/2/6/7 — analog press-depth outputs and two-key priority; HE-only, no khub916/mouse equivalent |

---

## 3. Compx mouse (`omg mouse`, `docs/protocol-compx-mouse.md`)

The entire "behavior" surface is the per-button flash record at
`96 + 4·i`: `type` 0 disabled / 1 mouse button / 2 DPI cycle / **5
shortcut / 6 macro**, plus a settings region (debounce, angle snap,
Motion Sync, sensor mode LP/HP, sleep). Shortcut records at `256+32·i`,
macros at `768+384·i`.

- Shortcut/macro are **static stored sequences** — there is no timing,
  threshold, layer, or multi-key-trigger parameter anywhere in the 189-byte
  settings map (full field table in `protocol-compx-mouse.md` §"Settings
  flash map").
- **Every inventory behavior: unsupported.** No tag space, no mode byte,
  no history region exists. (Evidence of absence: the vendor driver JS
  exposes only the fields listed; `omg-proto-mouse` `WRITABLE` allowlist
  covers exactly those addresses.)

## 4. SparkPlayJoy 6×21 (`omg-proto-sparkplayjoy`, `docs/protocol-sparkplayjoy.md`)

Strictly **read-only**: sync/identity, travel scale, default physical map,
Fn0 active-function map, live travel, status matrix. §7 "NOT implemented /
unknown": *"WRITE commands: none implemented; HallJoy's path is strictly
read-only."* Even if the firmware has config writes (V75 updater contains
unextracted paths), **no behavior encoding is known**.

- **Every inventory behavior: unsupported (unwritable).** The only
  behavior-adjacent datum is the Fn0 function map (u16 per key:
  HID usage / `0xF001` Fn / filtered internals) — a static keymap read,
  not a behavior engine.

---

## 5. Cross-protocol summary

| Behavior | khub916 | HE v2 | Compx mouse | SparkPlayJoy |
|---|---|---|---|---|
| Mod-Tap | ✅ code-verified (persist unconfirmed) | ✅ code-tested | ❌ | ❌ |
| Tap-Hold | ✅ same | ✅ same | ❌ | ❌ |
| Layer-Tap | ❓ tag `0x07` unknown | ❓ Fn keys, semantics unknown | ❌ | ❌ |
| Tap Dance | ❌ | ❌ | ❌ | ❌ |
| Combo (N-key trigger) | ❌ (chord *output* only) | ❌ | ❌ | ❌ |
| Key Override | ❌ | ◐ END=release-alt (not specced override) | ❌ | ❌ |
| One-Shot | ❌ | ◐ TGL maybe | ❌ | ❌ |
| Sticky | ◐ TGL (inferred) | ◐ TGL (inferred) | ❌ | ❌ |
| Caps Word | ❌ | ❌ | ❌ | ❌ |
| Auto Shift | ❌ | ❌ | ❌ | ❌ |
| Leader | ❌ | ❌ | ❌ | ❌ |
| Repeat Key | ❌ | ❌ | ❌ | ❌ |
| Mod-Morph | ❌ | ❌ | ❌ | ❌ |
| Conditional Layer | ❌ | ◐ Config1–4 = profile switch only | ❌ | ❌ |
| Macro behavior | ✅ live-verified | ✅ code-tested | ◐ static mouse macros | ❌ |
| SOCD | ✅ code-verified | ✅ code-tested | ❌ | ❌ |
| Analog depth behaviors | ❌ | ✅ DKS/MPT/RS (hw-unverified) | ❌ | n/a (read-only sensor) |

## 6. Recommended next reversing steps

1. **khub916 adv-key persistence (highest value):** the MT/SOCD/TGL
   history write (cmd 18) did not persist on K1 Pro. Before any UI work
   depends on it: retest on K1/K98 hardware, and check whether the vendor
   webapp performs an extra session step (e.g. a preceding query or a
   specific tag pair) before `sendAdvanKeyHistory`. Trace
   `processQueue`/`sendCommandDebounced` ordering in the deob JS around
   the adv-key save path.
2. **khub916 tag `0x07` ("S" secondary layer):** find any vendor code path
   that *writes* a `0x07`-tagged value (search `BasicChangeKeyCode` /
   `deviceAdapter` for secondary-layer UI); if none exists it is
   read-only firmware state. Determines Layer-Tap verdict.
3. **khub916 Fn/Fn1 hold semantics:** live-test whether `0x0D…` keys are
   momentary or latching (hold Fn, press another key, release). Cheap
   experiment on the K1 Pro we already own.
4. **HE HigherKey live verification:** `omg kb hk get` on a V75-class
   board to confirm the cat-6 read reply shapes, then single-key writes
   per `he-macros-research.md` §"Recommended probe sequence". This
   upgrades Mod-Tap/TGL/SOCD/RS/DKS/MPT from code-tested to live-verified
   and settles TGL one-shot-vs-sticky.
5. **HE layer-key semantics:** same live test for `0xF100–0xF103` —
   resolves Layer-Tap and whether Fn keys are momentary.
6. **khub916 combo chord:** confirm on hardware that a "CB" value behaves
   identically to the equivalent normal multi-modifier value (i.e. the
   firmware has no special combo state machine). If it does differ,
   re-open the Combo verdict.
7. **Wireless 916_wireLess adv keys:** codec exists but never exercised —
   needs a `0x3554:0xFA09` / `0x258A:0x0150` device.
8. **SparkPlayJoy writes:** only if a use-case demands configurability;
   the V75 updater firmware's write paths were never extracted
   (`protocol-sparkplayjoy.md` §7).
