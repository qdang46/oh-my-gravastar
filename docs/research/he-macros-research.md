# HE keyboard v2 protocol — categories 6 (HigherKey) & 7 (Macro) reverse notes

Status: **extracted from the official web driver JS** (no hardware capture needed for the
wire format). Date: 2026-… (see git log). Sources mirrored under `docs/research/he-webapp/`.

## Where the driver lives

The official HE keyboard configurator is **two separate web apps** on the same origin:

| App | URL | HID interface | Wire format |
| --- | --- | --- | --- |
| v1 app | `https://hub.gravastar.com/gravastar/` (aliases: `zlxq.sparklinkplayjoy.com/gravastar`, `hub.gravastar1.com/gravastar`) | usage page `0xFFA0` (65440) | SparkPlayJoy-style `5C <len> <cmd> <cksum>` frames, 64-byte reports |
| **v2 app** | `https://hub.gravastar.com/gravastar/v2/` | usage page **`0xFFB0` (65456)**, also `0xFF90` (65408) | **`[category, command, args…]` raw 64-byte reports — the protocol orbit implemented** |

The connect page (`index-CPkm8clc.js`, archived build) classifies a device as `"v1"`
(usagePage 65440) or `"v2"` (usagePage 65456) and redirects v2 devices to
`/gravastar/v2/device`. The v1 app *also* implements macros/advanced keys, but through the
`0x5C`-framed `higherKeyProtocol`/`keyProtocol` (`modeMacro`, `cmdLayout`, `setMacro` …) —
that is the **SparkPlayJoy/HallJoy-style** path, **not** the v2 categories 6/7. Do not
confuse the two; the khub-webapp mirror in this repo is the K1-series (916) driver and is
unrelated.

The v2 device table (from `v2/index-BEtzL_HV.js`): VID `0x1CA6` (7334) PIDs
11272–11276, 11282, 11283, 11284, 11288–11293, 11296–11298, 11300, 11305, 11306 and
VID `0x31E3` (12771) PID 4896 — identical to `PIDS` in `crates/proto-he/src/lib.rs`.

Mirrored files:

- `he-webapp/` — current live v1 app (`index-BWI4_t-Z.js` + chunks) and `v2/` — **current
  live v2 app** (`index-BEtzL_HV.js` engine + `index-Bd5dQyX3.js` device page).
- `he-webapp/archive-2025-11/` — Wayback snapshot 2025-11-16 of the v1 app
  (`index-CiCPiWdL.js` + `index-BrEsQfKe.js` + `index-CPkm8clc.js` …); kept for diffing.

The v2 protocol code is all in `v2/index-BEtzL_HV.js` (~900 KB, readable despite minification).
Key offsets for future re-extraction: enum block ~550300–560600, pack helpers ~560600–561600,
protocol classes ~596500–612000, controllers ~698000–752000.

## Transport (confirmed)

- `HIDDevice.sendReport(0, Uint8Array(64))` — output report id 0, exactly the orbit model.
- Replies arrive on `inputreport`; for usagePage `65456`/`65408` the driver uses the **whole
  64-byte buffer** (raw `[cat, cmd, …]` echo). Other pages strip a 4-byte frame header —
  that branch is the v1 protocol only.
- Requests are serialized through a command queue (`sendData` → `sendReportAndWaitResponse`,
  default 1 s timeout). `sendDataNoResponse` exists for fire-and-forget writes
  (e.g. direct-drive lighting).
- Writes take effect immediately; there is still **no commit/save command** — consistent
  with orbit's finding.

## Category map (authoritative, from the JS enum `aw`/`IC`)

`Device=1, Global=2, LayoutAndKey=3, Performance=4, Lighting=5, HigherKey=6, Macro=7,
FirmwareUpgrade=8, CustomCommand=10, ThreeMode=13, Voice=14, Touch=15, Handle=16,
Displayer=12`.

Global sub-commands (`IC`): `ResetFactory=1, SaveParam=2, ConfigSwitch=3, SystemSetting=4,
ReportRateSetting=5, CalibrationSetting=6, AxisLibraryQuery=7, EffectAreaQuery=8,
ModifyDefaultAxis=9, DoubleLightingQuery=10, SpecialLightingQuery=11, RtPrecisionQuery=12,
SleepTimeQuery=13, MacroSpaceInfoQuery=14, Restart=15` — every value matches the orbit doc,
which validates the whole table.

## Category 6 — HigherKey (advanced keys: DKS/MPT/MT/TGL/END/SOCCD/RS)

HigherKey mode byte (`kw`): `NONE=0, DKS=1, MPT=2, MT=3, TGL=4, END=5, SOCD=6, RS=7`.
R/W op byte (`fw`): `Read=1, Write=2`.

Base header: `[6, op, row, col, mode]` (row/col = matrix coordinates, mode = kw value).

| Mode | Write payload after header | Read reply layout (unpack) |
| --- | --- | --- |
| NONE | — | `{row,col,mode}` |
| DKS | `kcs[4]` u16 LE + `trps[4]` u8 + `dbs[2]` u16 LE (×1000 µm) | kcs @5-12 u16×4, trps @13-16 u8×4, dbs @17-20 u16×2 ÷1000 |
| MPT | `kcs[3]` u16 + `dbs[3]` u16 (×1000) | kcs @5-10 u16×3, dbs @11-16 u16×3 |
| MT | `kcs[2]` u16 + `time` u16 | kcs @5-8, time @9-10 |
| TGL | `kcs` u16 + `time` u16 | kcs @5-6, time @7-8 |
| END | `kcs[2]` u16 + `delay` u16 | kcs @5-8, delay @9-10 |
| SOCD | **two packets** (see below) | row2 @5, col2 @6, kcs @7-10, delay @11-12, socdMode @13 |
| RS | **two packets** (see below) | row2 @5, col2 @6, kcs @7-10, delay @11-12 |

### SOCD write (two output reports, sent sequentially)

`socdMode` mapping: `0→[0,0], 1→[1,2], 2→[2,1], 3→[3,3]` (direction pair).

- Packet A (for key at `row,col`): `[6,2, row,col, 6, row2,col2, kc0 u16, kc1 u16, delay u16, dirA]`
- Packet B (for key at `row2,col2`): `[6,2, row2,col2, 6, row,col, kc1 u16, kc0 u16, delay u16, dirB]`

Each packet names the *other* key's coordinates and swaps the keycode order — the pair is
cross-linked inside the firmware.

### RS write (same shape, mode byte 7, no socdMode byte)

- Packet A: `[6,2, row,col, 7, row2,col2, kc0, kc1, delay]`
- Packet B: `[6,2, row2,col2, 7, row,col, kc1, kc0, delay]`

### HigherKey reads

`[6,1, row,col, mode]` per key. The UI enumerates every key × every mode on connect
(`getHigherKeyData` for each `advancedKeyMode`), so reads are cheap and safe.

### Unsolicited events

`getSdkEventKey` maps input reports to events: category `6` → key `"6-<mode byte>"`,
category `5` → 4-byte key (lighting push). The firmware can push HigherKey/lighting
notifications asynchronously — a probe must tolerate unmatched input reports
(orbit's `request_matching` already retries; keep that behaviour).

## Category 7 — Macro

Sub-commands (`_w`): `GetMacroMode=1, SetMacroMode=2, GetMacro=3, SetMacro=4`.

### Macro mode (per macro slot)

- Read:   `[7, 1, macroId]`
- Write:  `[7, 2, macroId, valid, actNum u16 LE, repNum u16 LE, mode]`
- Reply parse (`macroModeRecData`): `macroId=e[2], valid=(e[3]===1), actNum=u16(e[4..5]),
  repNum=u16(e[6..7]), mode=e[8]`. `mode` is the UI macro mode (driver offers 4 modes:
  repeat / single / quick / etc. — see `macroMode` select in `index-Bd5dQyX3.js`; raw byte
  semantics unverified).

### Macro data (action list, paged)

- Read:  `[7, 3, macroId, offset]` → reply: `macroId=e[2], offset=e[3]`, then 4-byte
  actions from byte 4 to 63 (max 15 per page).
- Write: `[7, 4, macroId, offset, <15 × u32 LE actions>]` — the import path slices
  `actions.slice(15*n, 15*(n+1))`, i.e. **15 actions per packet, `offset` = page index**.

Action u32 (little-endian): `bit31 = status flag (1 = key-up/release?), bits 30..16 = delay
(≤ 32767, units TBD — UI divides by 10 somewhere; `timeDifference`), bits 15..0 = HID
keycode (≤ 0xFFFF)`. Encoder throws if delay > 32767 or keycode > 0xFFFF.
Decoder (`Gw`): `{status: t>>31&1, delay: (t>>16)&0x7FFF, keyCode: t&0xFFFF}`.

### Macro space info (category 2, NEW vs orbit)

`[2, 14, 0]` (`MacroSpaceInfoQuery`) → reply byte 3 = `macroCount`, bytes 4–5 =
`macroNumber` u16 (probably total/used macro slots — naming ambiguous, verify on hardware).
Useful before allocating `macroId`s.

## Category 3 — keymap writes (previously undocumented)

`keyProtocol` (`mw`): `GetKeyLayout=1, SetKeyLayout=2, GetKeyCode=3, SetKeyCode=4,
GetKeyLayoutStyle=5, GetKeyLayoutDefault=6`.

| Request | Meaning |
| --- | --- |
| `03 01 layer row` | read whole row: 21 × u16 keycodes from byte 4 (orbit ✓) |
| `03 02 layer row <21×u16>` | **write whole row** (all 21 codes at once) |
| `03 03 layer row col` | **read single keycode** → `keycode=u16(e[5..6])` |
| `03 04 layer row col <u16>` | **write single keycode** |
| `03 05 row` | layout style / geometry table (orbit's "physical geometry") |
| `03 06 …` | get layout default (pack fn exists; arg shape not fully traced) |

Note: orbit's `03 05` reply decodes packed u16s `y=bits15-11, x=bits10-4, size=bits3-0`;
the JS `keyLayoutStyleResult` decodes the same table as `{row:e/4, col:o/4, ratio:i}`
triples — same data, different interpretation (position in quarter-key units + size code).

Keycode values: plain HID usages for normal keys; `0xF1xx`/`0xF2xx`/`0xF3xx`/`0xF5xx`
function codes per orbit. The v2 app stores per-key `advancedKeyMode` inside the
Performance record (`advancedKeyMode` field seen throughout the UI state) — the link
between a key's cat-4 performance entry and its cat-6 mode assignment is via row/col.

## Category 10 — CustomCommand

`sendCustomCommandProtocol(payload[≤63])` → `[10, ...payload]`; `GFSOpenWebDriver` =
`[10, 1, e, t, n]` (driver handshake/keepalive?). Category 10 was already on orbit's
never-send list (`0A 01 01 FF` wipe) — probe only with care.

## Recommended probe sequence (read-only first)

All of these are reads the official driver itself issues; safe order:

1. `01 01`, `01 02`, `01 03` — identity (orbit ✓).
2. `02 03 00/01`, `02 04 01`, `02 05 00`, `02 0C 00`, `02 08 00`, **`02 0E 00`** (macro
   space — new, tells you how many macro slots exist before writing any).
3. `03 05 row` geometry, `03 01 layer row` keymap (orbit ✓).
4. **`06 01 row col mode` for mode 0 (NONE)** on a few keys — establishes that cat-6 reads
   answer at all and the reply shape (`[6,1,row,col,0]` echo).
5. `06 01 row col 1..7` per key to dump existing advanced-key config (DKS/MPT/MT/TGL/END/
   SOCD/RS) — the driver does exactly this on connect.
6. `07 01 macroId` for ids 0..N-1 (N from step 2) then `07 03 macroId 0` for macro data.
7. `04 01 row col` performance incl. `advancedKeyMode` echo (orbit ✓).

Only after reads look sane: single-key writes (`03 04`, `06 02` NONE→mode, `07 02/04`)
on a scratch key, each followed by a read-back — mirroring the driver's own write→read
pattern (`sendProtocol` always parses the write's reply).

## Risks / open questions

- **SOCD/RS two-packet writes**: order and cross-linking inferred from pack code; if the
  firmware expects both packets "atomically", send them back-to-back like the driver does
  (`sendData` on the array → sequential `sendReport` calls, ~µs apart).
- **Macro `status` bit / `delay` units**: `status` semantics (press vs release event?) and
  whether `delay` is µs/ms/0.1 ms are unverified — the UI stores `timeDifference` and one
  call site divides by 10. Resolve by recording a trivial macro in the web driver while
  sniffing (see below) or by write→read→compare round-trips.
- **`macroMode` byte values** (0–3) and `actNum`/`repNum` units: UI labels exist
  ("macroMode2/4" locale strings) but wire semantics unverified.
- **Category 10** `[10, …]` is a raw passthrough (`sendCustomCommandProtocol`) — powerful
  and unexplored; treat as write-only-blacklist until understood.
- **Unsolicited input reports** (cat 5/6 push events) can interleave with replies; the
  driver keys events off `[cat, cmd]`/`[6, mode]` — orbit's matcher must keep ignoring
  non-echoing reports.
- V60 Pro (orbit's test unit, fw 0.4.1.0) may have older firmware than current V75 boards;
  cat 6/7 may exist only on newer PCBs — the `02 0E` macro-space query will reveal support.

## USB capture fallback (if JS disagrees with hardware)

If a board answers differently than the JS predicts:

- The driver is plain WebHID `sendReport(0, …)` on usage page 0xFFB0 — capture with
  Wireshark/usbmon (Linux) or USBPcap (Windows) while clicking through the web UI's
  Advanced Keys / Macro panels; each click produces one 64-byte OUT report, replies are
  64-byte IN reports. The openrazer wiki's "USB capture" approach applies directly.
- `omg probe`/orbit `--probe` already dumps raw reports; extend it to log every IN report
  for ~30 s while the official driver edits a macro — unsolicited cat-6 events will show.
- Safe-to-probe writes: only `NONE` mode sets and macro writes to a *new* `macroId`
  (from `02 0E` count). Never probe `02 01`, `08 xx`, `0A 01 01 FF`, `10 02`, `02 0F 01`,
  `02 09`, cat `0C/0E/0F` (existing blacklist, unchanged).
