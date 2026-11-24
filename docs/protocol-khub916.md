# khub916 keyboard protocol — GravaStar Mercury K1 / K1 Pro / K98 Pro and SDK siblings

Status: **reversed from the vendor web configurator** (`docs/research/khub-webapp/`,
a mirror of the khub web driver JS). The wired "916" transport is **verified live**
against a GravaStar Mercury K1 Pro (VID 0x258a / PID 0x010c) with read-only queries
**and with the cmd 3/4/6 config writes** (keymap, profile, custom light colours —
each sent fire-and-forget and confirmed by read-back, 2026-11-24); the wireless
"916_wireLess" transport is code-verified only (no device attached).

Vendor JS engine classes (all in `index-M8-m9qFR.js`, deobfuscated copy at
`index-M8-m9qFR.deob.js` — generated locally, not committed):

| protocolKey | class | transport | used by |
|---|---|---|---|
| `916` (wired) | `Ht` (export `O`) | HID **feature** reports, 519-byte payload | `devicesInit-CDKz8T4Y.js` `n==="916"` |
| `916_wireLess` | `zt` (export `z`) | HID **output** reports, 19-byte payload + input-report stream | `n==="916_wireLess"` |
| `8815` | `Ot` (export `Y`) | feature reports, 519 B (same envelope as 916, different profile layout) | sibling protocol, out of scope |
| `8815_wireLess` | `Yt` (export `V`) | output reports, 19 B (same envelope as 916_wireLess) | sibling protocol, out of scope |
| `901` | `Gt` (export `G`) | feature reports, 519 B, different header | sibling protocol, out of scope |

Sibling classes share large amounts of code (macro/light/key logic is near-identical);
only the transport envelope and a few command IDs/profile offsets differ.

## 1. Device enumeration and selection [verified from JS + live]

WebHID (`navigator.hid`). `jt.requestDevice(filters)` / `jt.getDevices()`.
The app groups enumerated devices and picks a collection:

- **916 wired (`Ht` ctor):** collection with `featureReports.length > 0 &&
  inputReports.length > 0 && usagePage >= 65280` (0xFF00); `reportId =
  featureReports[0].reportId`. Live K1 Pro: vendor collection `usage_page=65280`,
  `reportId = 6`, `sendFeatureReport`/`receiveFeatureReport` on that report.
- **916_wireLess (`zt` ctor):** collection with `outputReports.length > 0 &&
  inputReports.length > 0` (no usagePage check); `reportId =
  outputReports[0].reportId`; uses `sendReport` + `oninputreport`.
- Fallback filter in `getGroupedDevices`: `featureReports>0 && inputReports>0`
  **or** `outputReports>0 && inputReports>0`.

### VID/PID tables (`index.js`, `const Ts`) [verified]

```
916 (wired):   VID 9610 (0x258a): PID 268 0x010c, 413 0x019d, 662 0x0296,
                            663 0x0297, 659 0x0293, 660 0x0294, 661 0x0295,
                            677 0x02a5, 733 0x02dd, 745 0x02e9
               VID 14234 (0x378a): PID 40960..40965, 40968 (0xa000..0xa005,0xa008)
916_wireLess:  VID 13652 (0x3554): PID 64009 (0xfa09)
               VID 9610: PID 336 (0x0150)  [listed twice]
               VID 14234: PID 40962 0xa002, 40966 0xa006, 40969 0xa009
8815:          VID 9610: PID 441 (0x01b9)
8815_wireLess: VID 9610: PID 563 (0x0233)
901:           VID 9610: PID 315 (0x013b)
```

### Model catalog (`index.js`, `const Dp`, 125 entries) [verified]

Each entry: `{model, name, password, type:X|J, protocolKey, keyType?, screen?}`.
`password` is **not a credential** — it is the 6-byte device UUID read back from
the keyboard (see §4). `type:X` = wired, `type:J` = wireless (same UUID for both).
`keyType` selects the legend/name table for `ut()` (0=default `Ca`, 1=`it` DE-ish,
2=`ot`, 3=`lt` JP-ish). Relevant GravaStar entries:

| model | name | password (UUID) |
|---|---|---|
| 916_K1 | GravaStar Mercury K1 | `0x0300000001b4` |
| 916_K1_PRO | GravaStar Mercury K1 PRO | `0x030000000197` |
| 916_K1_LITE | GravaStar Mercury K1 LITE | `0x0300000001b5` |
| 916_K98Pro | K98 | `0x0600000000b3` |
| 916_GravaStar_Mercury_NP_PRO | GravaStar Mercury NP PRO | `0x0600000000ad` |
| 916_GravaStar_Mercury_NP | GravaStar Mercury NP | `0x0600000000d4` |
| 916_K1_JP / K1_LITE_JP / K1_LITE_PRO_JP | JP layouts (keyType:3) | `0x030000000401/402/400` |
| 916_K1_PRO_DE / K1_DE / K1_LITE_DE | DE layouts | `0x0300000003f4/3f5/3f6` |
| 916_K98Pro_JP/DE/SE/KR | K98 variants | `0x06000000010c/104/110/113` |

K98 Pro additionally carries `screen:{vendorId:9610,productId:436}` — the
screen is a **separate HID interface** (the `va={916:[{9610,436}]}` table),
not part of the keyboard report protocol.

## 2. Transport — wired 916 (`Ht`) [verified live]

- `sendFeatureReport(reportId, buf)` where `buf` = 519-byte `Uint8Array`,
  zero-filled, command packet copied at offset 0 (`payloadBuffer.set(pkt,0)`).
  On the wire the feature report is 520 bytes: `[reportId=6][519 payload]`
  (hidapi required the report ID as buffer byte 0; WebHID passes it separately).
- `receiveFeatureReport(reportId)` returns a DataView; the JS converts to a byte
  array and **drops byte 0** (`s.shift()`), i.e. byte 0 is the report ID.
  Default timeout 3000 ms (`receiveFeatureReport(a=3e3)`).
- Commands are serialized through a FIFO (`Ye[]`, `processQueue`, ~30 ms spacing).
  `sendCommandDebounced` coalesces bursts: only the **last** queued command is
  sent after 100 ms.
- **No checksum, no sequence number, no ACK** on this transport. The device
  answers each command with a feature report that **echoes the 7-byte request
  header** followed by payload (verified live, §5).

### Request packet layout (wired) [verified live + code]

```
byte 0     command/opcode
byte 1     argument (layer|system flags for key cmds; 0/1 elsewhere)
byte 2     0x00 (always observed 0)
byte 3     0x01 (always observed 1)
byte 4     0x00 (always observed 0)
byte 5     tag A — command-class / expected-response tag (see table)
byte 6     tag B (present on most commands; paired with tag A)
bytes 7..  command payload (big-endian u32 key values, RGB planes, etc.)
```

Packets are **not** length-prefixed; they are placed in the 519-byte buffer and
zero-padded. Some payloads carry a `0x5A 0xA5` marker at the **end of the
packet** — for cmd 3 it overwrites the last two payload bytes (the keymap's
512-byte field is zero-padded first, so the marker lands inside the padding);
the profile blob simply contains `5A A5` as its last two data bytes
(live-verified). [inferred: end-of-data marker, not checksum — the wired
transport has no checksum at all].

**Write commands (3/4/6, and the screen cmds 11/12/13) are fire-and-forget**:
the vendor JS calls `sendFeatureReport` and never `receiveFeatureReport` for
them [verified from code + live]. Callers must verify writes by re-issuing
the matching query (131/132/134).

### Response packet layout (wired) [verified live]

```
byte 0     report ID (0x06 on K1 Pro)          <- dropped by JS shift()
bytes 1..7 echoed request header (cmd,b1,0,1,0,tagA,tagB)
bytes 8..  payload (variable length; observed 10..511 bytes)
```

JS then does `payload = resp.slice(7)` after the shift (i.e. skip report ID +
7-byte header = offset 8 on the wire). Errors `"Server error"` if fewer than
7 payload-header bytes. All `parseX()` functions return `resp.slice(7)`.

## 3. Transport — wireless 916_wireLess (`zt`) [code-verified only]

- `sendReport(reportId, buf)` — **output** report, `payloadBuffer` = **19 bytes**.
- `oninputreport` listener receives 19-byte input reports as
  `Array.from(new Uint8Array(e.data.buffer))` — **no report-ID shift**.
- Packet body (≤18 bytes) + 1 checksum byte = 19; zero-padded.

### Checksum (wireless) [verified from code]

```
cs = (reportId + Σ body[0..n-1]) & 0xFF      // simple additive checksum
packet_on_wire = body[0..n-1] ++ [cs]        // then zero-pad to 19
```

`calculateChecksum(a)` sums every byte of `a` (which the caller builds as
`[reportId, ...body]`) and returns `sum & 0xFF`; callers append it:
`new Uint8Array([...body, cs])`.

### Request packet layout (wireless) [code-verified]

Fixed 7-byte header for queries: `[cmd, sub, 0, 0, 0, 0, 0]` then checksum.
Large writes are **chunked**: payload split into 14-byte chunks; each packet:

```
byte 0   command (1=keymap write, 2=custom-light write, 3=macro write,
               4=profile/config write, 9=light-data write, 18=adv-key write)
byte 1   total packet count (≤255)
byte 2   packet index (0-based)
byte 3   last-chunk marker: valid data bytes in final chunk
         (cmd1: layer<<4 | lastLen%14; cmds 2/4/3: lastLen%14, or 2 when %14==0;
          cmd18: lastLen%14)
bytes 4..17  up to 14 payload bytes (zero-padded)
byte 18  additive checksum (includes reportId)
```

Last chunk of keymap writes (cmd 1) embeds `0x5A 0xA5` inside the data area
(`m[b+1]=90, m[b+2]=165`) as end marker; light-data write (cmd 9) writes
`I[6]=90, I[7]=165` on the last packet.

### Response packet layout (wireless) [code-verified]

19-byte input report, reassembled by `parseKeyboardProfile()`:

```
byte 0    sequence/report byte (keepalive packets start with 0x0A)
byte 1    total packet count r (>0)
byte 2    packet index s (0..r-1)
byte 3    flags/unused
bytes 4..17  14 bytes payload
byte 18   checksum (excluded via slice(4, len-1))
```

Packets may arrive in any order; the JS collects until `r` distinct indices
arrive (20 s overall budget `bt=20000`, per-packet wait `He=5000`), then
concatenates `slice(4,18)` of each. Keepalive/status packet:
`[10,1,0,4,2, ...]` (19 B) → routed to `statusListeners` (online flag `n[5]==1`,
battery `n[5]`/`n[6]`), never to command waiters.

## 4. Auth / session [verified live + code]

There is **no challenge-response and no password command**. "Auth" = device
identification:

1. On connect the app sends the device-info query (cmd 130 wired / cmd 5 wireless).
2. Device replies with a 6-byte UUID + 2-byte version + 1-byte screen size.
3. `isPasswordCorrect(uuid, isWireless)` looks the UUID up in the `Dp` catalog
   (`password` field); unknown UUID → "password error" and the device is rejected.

So the UUID is effectively a model/license key burned into firmware.

### Device info response (wired, live-verified on K1 Pro)

Request:  `[0x82, 0x01, 0x00, 0x01, 0x00, 0x0A, 0x00]` (cmd 130)
Response: `[06][82 01 00 01 00 0A 00][03 00 00 00 01 97][01 00][00][00 00]
           ^reportID  ^echoed hdr   ^uuid(6B)      ^ver  ^scr ^pad`

- uuid bytes → `"0x" + hex` = `0x030000000197` → catalog `916_K1_PRO` ✓
- version `0x0100`; screenSize byte `0x00` → no screen (K1 Pro reports none;
  K98 Pro uses the separate screen interface instead)
- `screenSize` map `Ha`: 1={128,128}, 2={160,80}, 3={240,135}, 4={240,240},
  5={320,172}, 6={428,142}, 7={170,320}

Wireless equivalent: cmd `[5,1,0,0,0,0,0]`; response parsed by
`parseUUIDFromResponse` as `slice(4,10)` uuid, `slice(10,12)` version,
`slice(12)` screen byte (input-report indexing).

## 5. Live verification log (K1 Pro, 2026-11-24, macOS hidapi) [verified]

Device `DevSrvsID:4295306107`, usage_page 0xFF00 collection, reportId 6.
Only query commands were sent (the same ones the web driver issues on connect).

| sent (after reportID) | response (hex, after reportID) | decoded |
|---|---|---|
| `82 01 00 01 00 0A 00` | `82 01 00 01 00 0A 00 03 00 00 00 01 97 01 00 00 00` | uuid `0x030000000197`, ver `0x0100` |
| `84 00 00 01 00 80` | 135 B total | profile blob, payload `slice(7)` ≈128 B |
| `87 00 00 01 00 02` | `87 00 00 01 00 02 00 64 11` | power: level=0x64=100, flags 0x11 → charging+full |
| `8A 00 00 01 00 E1 01` | 490 B | light color data (~480 B payload) |
| `85 00 00 01 00 00 02` | 519 B | macro region (full-size response) |
| `83 00 00 01 00 F8 01` | 511 B | key map: first u32 BE `0x00000029`=41=ESC, then 53,43,57 = Backquote/Tab/CapsLock — matches `Ca` table order |

Confirms: report-ID byte, 7-byte echoed header, big-endian u32 key values,
`slice(7)` payload offset, variable-length responses up to 519 payload bytes.

### Write verification log (K1 Pro, 2026-11-24, `omg kb916 set … --yes`)

The vendor JS only ever calls `sendFeatureReport` for write commands and
never reads a reply, so writes are fire-and-forget feature reports followed
by the matching query as read-back verify (150 ms settle, vendor command
spacing is ~30 ms / 100 ms debounce).

| write | verification |
|---|---|
| cmd 4 profile (`set sleep`, `set light-mode`) | `sleep 2→3→2` persisted across reads; `light-mode 15 4 0 → 15 8 12 → 15 4 0` changed profile bytes 86/87 (`00 47`→`0C 87`→`00 47`) exactly per the `findSecond255Index` record layout; full 128-byte blob read-back identical each time |
| cmd 6 custom light (`set light-color 0`) | `#0000FF→#FF0000→#0000FF` on slot 0 (pos 8) persisted across reads |
| cmd 3 keymap (`set key`, `set keymap`) | full-table no-op write of all 126 read entries verified; slot 100 `0x00000000→0x00000004→0x00000000` persisted across reads (`A` label appeared and cleared) |

Keymap entry count resolved: the K1 Pro **read returns a fixed 126 u32
entries** (504 payload bytes; trailing slots are zero but still returned —
the count is model-dependent, not trimmed). The write path pads to the
protocol's 128 slots exactly like the vendor `formatKeyPayload`
(zero-fill to 512 B) and the verify compares zero-padded to 128 — see §8.

## 6. Command map — wired 916 (`Ht`) [verified from code; queries + cmd 3/4/6 writes live-verified]

Request header: `[cmd, arg, 0x00, 0x01, 0x00, tagA, (tagB), payload...]`.
`arg` = `layer & 3 | ((system ?? 0) & 1) << 2` for keymap cmds 3/131.

| cmd | name | dir | tagA/B | payload | JS source |
|---|---|---|---|---|---|
| 3 | write key configuration | → | 248/1 | 512 B: u32 BE values zero-padded to 128 slots; `5A A5` **overwrites the payload's last two bytes** (packet bytes 517/518), not appended | `setKeyboardKeys`, `sendKeyConfiguration` |
| 4 | write profile/config blob | → | 128/0 | ~128 B profile verbatim incl. its trailing `5A A5` (see §7) | `setKeyboardSleepTime`, `setKeyboardLight` |
| 5 | write macro region | → | len&0xFF/0 | ≤512 B assembled macro table | `setKeyBoardMacroKey`, `deleteKeyBoardMacroKey`, `setKeyBoardMacroIndependent` |
| 6 | write custom light colors | → | 122/1 | 378 B (126×R,126×G,126×B planes), no marker | `setKeyboardCustomLightColor(Array)` |
| 8 | GIF light frames | → | 122/1 | 512 B frames, 7-B prefix `[8,0,0,1,0,122,1]`, data at +7 | `setGifLight` — **live-probed on K1 Pro** (see below) |
| 10 | write light colour data | → | 0/2 | header `[10,0,0,0,0,0,2]` (**byte 3 = 0x00**, not the usual 0x01) + ~483 B blob at offset 7; `5A A5` pinned at packet bytes **513/514** | `setKeyboardLight` (`type==1 && color` branch) |
| 11 | set screen time | → | 14/0 | `[0,0,0,0] + 7B datetime + week` | `setKeyBoardScreenTime` |
| 12 | screen image data | → | 0/2 | `[0,frameIdx,chunkIdx,0,0,2] + 512 B` per frame | `setKeyBoardImg` |
| 13 | screen image header/footer | → | 5/(64 or 0) | `[count&255,0,interval&255,interval>>8]` | `setKeyBoardImg` |
| 17 | keyboard reset | → | 1/0 | 1 B type | `setKeyboardReset` |
| 18 | write SOCD/MT/TGL history | → | 0/2 | 200+200+112 = 512 B | `sendAdvanKeyHistory` |
| 130 | get device info (UUID/ver/screen) | ↔ | 10/0 | resp: uuid6+ver2+scr1 | `getDeviceBasicAttributes` |
| 131 | get key map | ↔ | 248/1 | resp: u32 BE ×N keys | `getKeyboardKeys` |
| 132 | get profile blob | ↔ | 128/— | resp: ~128 B | `getKeyboardProfile` |
| 133 | get macro region | ↔ | 0/2 | resp: ≤512 B | `getKeyBoardMacroKey` |
| 134 | get custom light colors | ↔ | 122/1 | resp: 378 B | `getKeyboardCustomLightColor` |
| 135 | get power/battery | ↔ | 2/— | resp: `[level, flags]` | `getKeyboardPower` |
| 138 | get light color data | ↔ | 227/1 | resp: ~480 B | `getKeyboardLightColor` |
| 146 | get SOCD/MT/TGL config | ↔ | 0/2 | resp: 512 B (200+200+112) | `getKeyboardAdvancedKey` |

### Key value encoding (u32 BE) [verified from code + live]

`be()` decodes each u32:

- bits 31..24 = type tag: `0` normal, `3` macro, `7` secondary-layer key,
  `32` SOCD, `33` MT, `34` TGL
- macro (tag 3): bits 23..16 = macroType `h`, bits 15..8 = macroNum `x`,
  bits 7..0 = macroIndex `v` → key value string `"0x03"+h+x+v` (hex, padded)
- normal: `value = (modifiers << 16) | HID_usage` where modifier bits are
  HID-usage-page-7 usages shifted: bit16=Ctrl(0x10000), bit17=Shift(0x20000),
  bit18=Alt(0x40000), bit19=GUI(0x80000); dual encodings exist
  (e.g. `0x00800007` and `0x80000007` both = LWin+D). `0x0D000000`=Fn,
  `0x0D010000`=Fn1. Mouse buttons `0x101xxxx`/`0x102xxxx`/`0x103xxxx`/
  `0x104xxxx`/`0x105xxxx`. Media keys `0x200xxxx`/`0x200xxxx00` pairs.
  Full name tables: `Ca` (868 entries, default), `it`/`ot`/`lt` (regional
  variants selected by `keyType`).
- `pos = 8 + n*4` (key index → config/light table position),
  `effect_pos = 8 + n*3`, `light_pos = 8 + n*1`.
- Combo keys (tag 0, special value list): bits encode two keys —
  `value = (keyA_mods | keyB_mods) << 16 | keyC_usage` (approx; see
  `setKeyboardComboKey`).

### Profile blob (cmd 132/4) [code-verified]

~128 B device configuration. Layout used by the JS:

- `profile[9..10]` = current light mode `u` (`e[9]!=0 ? e[9]<<8|e[10] : e[10]`)
- `findSecond255Index` locates first `FF FF` pair → base `t`
- per-mode records at `t + mode*2 - 2` (bright) and `t + mode*2 - 1`
  (speed<<4 | type); modes `0,19,275,277` are special (no per-mode entry)
- `profile[24]` = sleep time (seconds)
- `profile[1]` = system/layout byte (used by `getKeyboardSystem` in siblings)
- light "type": speed nibble `s = speed&15`, `typeCode = (type==1 ? 0 : 7)`,
  packed `s<<4 | typeCode` written back at `t+mode*2-1`.
- Decode (`getKeyboardLight`, wired): the record index uses `profile[10]`
  (mode low byte); modes `0,19,275,277` report speed=0/bright=0/type=1;
  mode 1 reports speed=0; packed low nibble `7` → colour model 2
  (mixing), anything else → 1 (monochrome). `speed`/`bright` are limited
  to ≤ 20 by the vendor `setKeyboardLight`.

### Custom light colors (cmd 134/6) [code-verified]

378 bytes = 126 entries × 3 planes: `[R×126][G×126][B×126]`; entry `i` has
`pos = 8 + i*4`, color `{r=plane0[i], g=plane1[i], b=plane2[i]}`.
Write replaces the whole 378-B blob (partial edits are read-modify-write).

### Light color data (cmd 138 read / cmd 10 write) [live-verified on K1 Pro]

483-byte blob on the K1 Pro = **23 groups × 21 bytes**, group `m` at
`m*21`. Bytes `0..3` of each group are the mode's RGB colour
(`getGroupColor`/`updateGroupColor`); the remaining 18 bytes are a
constant firmware template (all 23 groups identical live — semantics
unknown, never interpreted). Modes ≥ 23 and the special modes
`0/19/275/277` have no group; `updateGroupColor` silently no-ops
out-of-bounds. Effect modes/speeds/brightness live in the **profile**
blob (§"Profile blob"), not here.

Wired write is **cmd 10**, sent only by `setKeyboardLight` when
`type==1 && color` (monochrome single-colour effects): packet
`[10,0,0,0,0,0,2]` + blob at offset 7, zero-padded to 519, `5A A5` at
packet bytes 513/514 (fixed offsets — a vendor quirk, not end-of-data).
The wireless equivalent is the chunked cmd 9 (§7). The vendor JS sends
*only* cmd 10 in that branch and skips the cmd-4 profile write — `omg`
deliberately sends both, each read-back verified (see
`docs/lighting-schema.md`).

### Macro region (cmd 133/5) [code-verified]

≤512 B assembled by `assembleGroupsWithLog` (all 4-B headers first, then all
bodies). Entry header (4 B LE-ish): `[lenLo,lenHi, ?, ?]` with embedded
`offset`/`length` fields parsed by `extractPossibleHeaders`; name = UTF-8
string after header; each macro step = 4 B `[action<<4|durHi, durMid, durLo,
keyUsage]` (duration = 24-bit big-endian-ish `(A&15)<<16|b<<8|I` where `A` is
step byte0). Action map `{0:0,1:0,8:1,9:1,2:0,10:1}`; modifier keys
Shift/Ctrl/Meta/Alt get action 1 or 9, mouse buttons 2 or 10.

### Cmd 8 live probe (K1 Pro, 2026-11-24) [verified transport; LED effect unconfirmed]

Vendor `Ht.setGifLight` chunks a flat byte stream into 378-byte pieces;
each becomes one packet `[8,0,0,1,0,122,1]` + data at offset 7, zero-padded
to the 519-byte feature report, sent fire-and-forget through the same
~30 ms command queue as every other write. **No** chunk index, frame
count, checksum or `5A A5` marker — the device consumes the stream
continuously. 378 B = 126 keys × 3; the planar `[R×126][G×126][B×126]`
order of cmd 6 is the working assumption (interleaved RGB not excluded).

Live findings (`omg-proto-khub916/examples/gif_probe.rs`,
`omg kb916 light stream`):

- `feature_exchange` on a cmd-8 packet **is answered**: the device echoes
  the 7-byte header and returns a 385-byte reply = header + 378-byte
  payload. The payload is a structured table (u32-BE values in the
  key-usage range plus a `5A A5` marker) and is **byte-identical for
  different frame colours** — it is device state (key/position data the
  GIF editor queries), not a frame echo. Exact semantics unconfirmed.
- Sustained `feature_write` streams of 378-byte frames at 30 fps and
  50 fps completed without transport errors (fire-and-forget, so no
  device NAK is observable either way).
- Whether the streamed bytes actually drive the LEDs could not be
  confirmed programmatically — no read-back path exists for cmd 8 and
  visual confirmation needs eyes on the keyboard. Open item tracked in
  `docs/research/music-reactive-feasibility.md` §6 (TEST-001).

### SOCD / MT / TGL (cmd 146/18) [code-verified; reads + keymap write live-verified on K1 Pro; cmd 18 did not persist on K1 Pro — see docs/advkeys-schema.md]

512 B history blob = SOCD 200 B + MT 200 B + TGL 112 B (regions in blob
offsets 0..200 / 200..400 / 400..512). Slot sizes: SOCD 8 B, MT 8 B,
TGL 4 B — each holds the keys' original u32 values serialized big-endian
(2–3 u32s for SOCD/MT, 1 for TGL). Free slot = first run of 4 consecutive
zero bytes in the region (`processHistory` fills it, else appends);
vendor clears blob bytes 510/511 (TGL footer) on every write.

Keymap side: the adv-key set path writes the keymap through
`sendKeyConfiguration` = **cmd 3** with header `[3,0,0,1,0,0,2]` (arg 0,
tags 0/2 — distinct from `write_keymap`'s 248/1 header), then the history
blob via cmd 18 (tags 0/2). Keymap binding u32 values encode
`kind-tag(0x20/0x21/0x22) | slot << 16 | param`, where slot is counted
over non-zero groups and bases are SOCD `0x20000000`, MT `0x21000000`,
TGL `0x22000000` (plus `(nonzero_slots-1)*0x10000`, MT adds `time` in
the low 16 bits, SOCD adds direction/`+256` for key B).

Full slot/binding layout, write-planner semantics and the CLI mapping
live in `docs/advkeys-schema.md`; codec: `crates/proto-khub916/src/advkey.rs`.

## 7. Command map — wireless 916_wireLess (`zt`) [code-verified only]

Query headers are 7 B `[cmd, sub, 0,0,0,0,0]` + checksum, zero-padded to 19 B.
Writes use the chunked format of §3.

| cmd | name | payload | notes |
|---|---|---|---|
| 1 | write keymap (chunked) | 512 B u32 BE values, 14 B/chunk | last chunk embeds `5A A5` |
| 2 | write custom light colors | 512 B (378 B data padded) | chunked |
| 3 | write macro region | ≤512 B | chunked; also used by `deleteKeyBoardMacroKey` |
| 4 | write profile/config | ~128 B | chunked; also sleep-time write |
| 5 | get device info | — | → uuid/version/screen |
| 6 | reset | `[6,1,0,type]` padded to 18 B | clears cached state `R` |
| 9 | write light color data | 512 B | chunked; `5A A5` marker on last (wired equivalent: cmd 10, §6) |
| 18 | write SOCD/MT/TGL history | 512 B | chunked |
| 65 | get key map | `[65,0,sys<<7,layer<<4,0,0,0]` | multi-packet resp |
| 66 | get custom light colors | `[66,0,0,0,0,0,0]` | → 378 B |
| 67 | get macro region | `[67,0,0,0,0,0,0]` | → ≤512 B |
| 68 | get profile | `[68,0,0,0,0,0,0]` | retried ×5 (`xe=5`) |
| 73 | get light color data | `[73,0,0,0,0,0,0]` | → ~480 B |
| 74 | get power | `[74,1,0,0,0,0,0]` | → `[level,flags]` |
| 82 | get SOCD/MT/TGL config | `[82,0,0,0,0,0,0]` | → 512 B |

Wireless response reassembly, keepalive handling, and retry policy
(5 attempts, linear 100·n ms backoff for keys; `Math.min(100,t)` for others)
are in `parseKeyboardProfile`/`waitDataPacket`/`inputReport`.

## 8. Unknowns / inferred items

- Byte 2/3/4 of the wired header are constant `0,1,0` in every observed
  command — likely fixed protocol version markers [inferred].
- tagA/tagB pairs look like an expected-response channel tag; exact semantics
  unconfirmed [inferred].
- The `0x5A 0xA5` marker sits at the **end of the 519-byte packet**: for
  cmd 3 it overwrites the last two bytes of the zero-padded 512-byte key
  payload (so slot 127's low half reads `5A A5` on the wire), and the
  profile blob carries it as ordinary trailing data. It is an end-of-data
  marker, not a checksum (no checksum exists on the wired transport)
  [inferred; positions code-verified, live writes confirmed].
- Keymap slot count is **model-dependent**: the K1 Pro read returns a fixed
  126 u32 entries (trailing zero slots are still returned, not trimmed).
  Writes always send the full 512-byte/128-slot field zero-padded; the
  read-back verify therefore compares zero-padded to 128 entries. Other
  models (K98) may report a different count — the same padding rule
  applies [live-verified on K1 Pro].
- Whether the firmware *stores* the two spare slots (126/127) or ignores
  them is unconfirmed; values written there are not observable via cmd 131
  on the K1 Pro [inferred].
- Wireless input-report byte 0 role (report-ID echo vs sequence) unconfirmed;
  keepalive packets begin `0x0A 0x01 0x00 0x04 0x02` [inferred].
- Wireless `916_wireLess` devices were not available for live test; the
  19-byte/14-byte-chunk protocol is documented from code only.
- `901` (Gt) and `8815`/`8815_wireLess` (Ot/Yt) are different protocol
  families sharing this SDK; Ot reuses the 916 wired envelope, Yt reuses the
  916_wireLess envelope. Out of scope here.
