# khub916 screen / image protocol (K98 Pro and siblings)

Status: **reversed from the vendor web configurator** (`docs/research/khub-webapp/`).
All findings are **code-verified only** — no screen-capable device was attached
during the original reversing session, and none was available for this pass
either. Nothing here has been confirmed on hardware.

Scope: how the khub web app's GIF editor ("GIF编辑", `GifEdit-DAt4o8US.js`)
pushes animation frames to the device screen, and how the screen device is
enumerated. Companion to `docs/protocol-khub916.md` (keyboard transport).

## 1. Two screen topologies [code-verified]

The device catalog (`index.js`, `const Dp`) marks screen-capable models with a
`screen` field in two different shapes:

| catalog entry | `screen` value | meaning |
|---|---|---|
| `916_K95` (A99PRO) | `{width:160, height:80}` | screen is **on the keyboard HID interface**; dimensions only |
| `916_K98Pro`, `916_K98Pro_JP/DE/KR`, `916_K80`, `916_GravaStar_Mercury_NP_PRO` (+ `_wireLess` twins) | `{vendorId:9610, productId:436}` (shared const `Me = va["916"][0]`) | screen is a **second HID interface** |

`va = {916: [{vendorId: 9610, productId: 436}]}` — VID `0x258A`, PID `0x01B4`.
Only the wired `916` protocolKey has a screen-interface entry; wireless models
reuse the same catalog `screen` object but there is no wireless screen transport
in the JS (see §6).

### Topology A — separate screen interface (K98 Pro) [code-verified]

- `screensInit-CJq-VH97.js` wraps class `nn` (export `o` of
  `index-M8-m9qFR.js`, deobfuscated copy `index-M8-m9qFR.deob.js`).
- Enumeration: `getDevices([{vendorId:9610, productId:436}])` /
  `requestDevice(same filter)`. `setDevice()` requires **all** returned devices
  to share the same vid/pid (multi-interface collect).
- `nn` constructor picks the collection with `featureReports.length>0 &&
  inputReports.length>0 && usagePage>=65280` — **the same filter as the wired
  keyboard class `Ht`** — and uses `featureReports[0].reportId`.
- `nn` implements **only** `open()`, `setKeyBoardImg()`, progress callback and
  the send queue. There is no query/parse/receive path: the screen interface is
  treated as write-only by the app.
- `MainLayout-D43lXfqC.js` opens the screen device automatically on layout
  mount when `currentDevice.screen` exists (`X.getGroupedDevices()` →
  `X.setDevice()`), before the user opens the GIF editor.

### Topology B — screen on the keyboard interface (K95) [code-verified]

- `screen:{width,height}` carries no vid/pid, so `screensInit` is never used;
  `GifEdit` falls back to the keyboard device adapter (`Ft` =
  `deviceAdapter-1I3s9kbL.js` export `D`), which calls
  `Ht.setKeyBoardImg()` / `Ht.setKeyBoardScreenTime()` on the **same**
  519-byte feature-report transport as all other keyboard commands.
- `Ht.setKeyBoardImg` and `nn.setKeyBoardImg` are byte-for-byte identical in
  packet construction (only inter-command delays differ: 30 ms vs 50 ms, and
  queue spacing 200 ms vs 20 ms).

## 2. Transport (both topologies) [code-verified]

Identical to wired `916` (`Ht`), see `protocol-khub916.md` §2:

- HID **feature reports**; `payloadBuffer` = 519-byte `Uint8Array`, command
  packet copied at offset 0, zero-padded. On the wire the report is
  `[reportId][519 payload]`; WebHID passes the report ID separately.
- Commands serialized through a FIFO queue (`processQueue`); image chunks are
  additionally paced by `delay()` inside the loop.
- **No checksum, no sequence number, no ACK.** `nn.calculateChecksum()` /
  `Ht.calculateChecksum()` compute `sum(frameIdx)+sum(chunkIdx)+sum(data) & 0xFF`
  but the return value is **discarded** at both call sites — dead code carried
  over from the wireless implementation. Do not send a checksum byte.
- `receiveFeatureReport` exists only on `Ht`; `nn` never reads. Screen writes
  are fire-and-forget.

## 3. Screen commands [code-verified]

All packets use the standard 7-byte wired header prefix `[cmd, 0, 0, 1, 0, tagA, tagB]`
(byte1 arg is always 0 for screen commands).

### cmd 13 — image session begin / end (header/footer)

Sent once **before** the first frame chunk and once **after** the last.

Begin (`Ht.setKeyBoardImg`, `nn.setKeyBoardImg` — identical):

```
byte 0     13 (0x0D)
byte 1     0x00
bytes 2-4  0x00 0x01 0x00   (fixed)
byte 5     0x05  (tagA)
byte 6     0x00  (tagB)
byte 7     64    (0x40) begin marker   [footer sends 0x00 here]
byte 8     frameCount & 0xFF
byte 9     0x00                  (frameCount high byte — always 0)
bytes10-11 frameInterval & 0xFF, (frameInterval>>8) & 0xFF   (u16 LE)
bytes12..  zero-pad to 519
```

End/footer packet: same layout except `byte7 = 0x00`.

- `frameInterval` is validated `<= 65535` (`"The time interval shall not exceed
  65535"`). Caller computes `Math.round(1000 / fps)` — **milliseconds per frame,
  u16 LE** [unit inferred: ms from `1000/fps`; the device-side interpretation
  is unverified]. Editor default when fps is invalid is `0`.
- `frameCount` is written as `count & 0xFF` with high byte hardcoded 0 → the
  wire format supports ≤255 frames; the editor UI caps lower (§5).

### cmd 12 — frame pixel data (chunked)

One packet per 512-byte chunk, per frame, in order:

```
byte 0     12 (0x0C)
byte 1     0x00
byte 2     frameIndex & 0xFF        (0-based, resets chunk counter per frame)
byte 3     chunkIndex & 0xFF        (0-based within the frame)
byte 4     0x00
byte 5     0x00
byte 6     0x02  (tagB)
bytes 7..518  up to 512 bytes of frame data, zero-padded
```

Exactly fills the 519-byte payload (7 + 512). The JS builds
`[12,0,frameIdx,chunkIdx,0,0,2, ...512B]`.

- Each frame is `width*height*2` bytes of **RGB565, big-endian** pixel data
  (see §4). 160×80 → 25 600 B → **50 chunks/frame**.
- `frameIndex`/`chunkIndex` are u8 → ≤255 frames and ≤255 chunks/frame
  (≤130 560 B/frame on the wire).
- Frames are sent sequentially: all chunks of frame 0, then frame 1, … No
  interleaving, no per-chunk wait-for-ACK.

### cmd 11 — screen clock sync (keyboard interface only)

`Ht.setKeyBoardScreenTime({time, week})`, wired only:

```
byte 0     11 (0x0B)
byte 1     0x00
bytes 2-4  0x00 0x01 0x00
byte 5     0x0E  (tagA = 14)
byte 6     0x00
bytes 7-9  0x00 0x00 0x00
bytes10-16 datetime[7]: year&0xFF, (year>>8)&0xFF, month, day, hour, min, sec
                     (from "YYYY-MM-DD HH:MM:SS"; each field already 0-99/0-59)
byte 17    week  (JS Date.getDay(): 0=Sunday … 6=Saturday)
bytes18..  zero-pad to 519
```

Called from the GIF editor's "sync time" button via
`deviceAdapter.calibrateScreenTime()` → only when `protocolKey === "916"`
(wired). On wireless models it is a no-op (`return null`). Whether the keyboard
forwards this to a separate screen interface, or the screen has its own RTC set
elsewhere, is **unknown** — `nn` exposes no time command.

### cmd 8 — GIF light frames (NOT the screen)

`Ht.setGifLight` / `Ot.setGifLight`: `[8,0,0,1,0,122,1]` prefix + 378-byte
chunks of per-key RGB data in a 512-byte packet — this drives the **keyboard
backlight GIF**, unrelated to the display. Do not confuse with screen image
transfer.

## 4. Frame format [code-verified]

Client-side pipeline (`GifEdit-DAt4o8US.js`):

1. GIF decode is **entirely in the browser** — `gifuct-js` `parseGIF` +
   `decompressFrames(frames, true)`, composited on `<canvas>` honoring
   disposal types 2/3 and transparent index, then `getImageData` → RGBA
   `Uint8ClampedArray` per frame at the target resolution. **The device never
   sees a GIF container** — only raw pixel frames.
2. Static images (png/jpeg/webp/bmp) are converted to a single-frame GIF first
   (gifenc, `go()`), then the same path.
3. Each RGBA frame is converted to the wire format by:

   ```js
   // r,g,b bytes -> u16
   v = ((r >> 3) & 31) << 11 | ((g >> 2) & 63) << 5 | ((b >> 3) & 31)
   // emitted big-endian: push(v >> 8), push(v & 0xFF)
   ```

   i.e. standard **RGB565, high byte first**, row-major, top-to-bottom,
   `width*height*2` bytes per frame. Alpha is dropped (only r,g,b read).
4. Target resolution = `currentDevice.screen.width/height` from the catalog,
   defaulting to **160×80** when absent (which covers K98 Pro — its `screen`
   field has only vid/pid). GIF frames are scaled to that size on import.
5. Max frame count enforced in the editor (`CustomButtonGroup`):
   - `width===428 && height===142` → 30 frames
   - `width>160 && height>128` → 40 frames
   - otherwise → **150 frames**
   Layers are truncated to this cap before saving.

## 5. Timing / flow control [code-verified]

- Per chunk: `await delay(50)` on the screen interface (`nn`), `delay(30)` on
  the keyboard interface (`Ht`), plus one extra `delay(50/30)` after each
  frame finishes. At 160×80/50 chunks this is ~2.5 s of pacing per frame on
  `nn`, ~1.5 s on `Ht`, on top of HID transfer time.
- `nn` queue spacing between commands: 20 ms; `Ht`: 200 ms.
- Progress callback reports `floor(chunksSent / totalChunks * 100)`.
- No backpressure from the device; the fixed delays are the only pacing.

## 6. Wireless screen path [unknown / likely absent]

`916_wireLess` models (incl. `916_K98Pro_wireLess`) carry the same catalog
`screen` vid/pid, but:

- `screensInit` is only invoked with the wired-style vid/pid filter and `nn`
  is a feature-report class — there is **no** screen-over-wireless-output-report
  implementation in the mirrored JS.
- `calibrateScreenTime` explicitly returns `null` for non-`"916"` protocols.
- The GIF editor would still attempt `Vt.getGroupedDevices()` and prompt for a
  wired screen interface if one enumerates; otherwise falls back to the
  wireless keyboard device's `setKeyBoardImg` — but `zt` (916_wireLess) has no
  `setKeyBoardImg` method in the deobfuscated engine, so the save would fail.

Treat wireless screen support as **not implemented in this web app version**.

## 7. Porting notes

- Reuse the wired `Ht` transport: `sendFeatureReport(reportId, 519B buffer)`.
  For the separate screen interface, open VID `0x258A`/PID `0x01B4`, pick the
  `usagePage>=0xFF00` collection with feature+input reports, use
  `featureReports[0].reportId` (expected 6 — the catalog mapper emits
  `reprotId:"0x06"` for 916 devices — but **unverified for PID 0x01B4**).
- Begin: cmd 13 header with marker `0x40`, frame count u16-LE-ish
  (`count&0xFF, 0x00`), interval u16 LE at bytes 10-11.
- Per frame: `ceil(w*h*2/512)` packets of `[12,0,frameIdx,chunkIdx,0,0,2]` +
  512 B zero-padded RGB565-BE data. Pace ≥30-50 ms per packet.
- End: cmd 13 footer with byte7 `0x00`.
- 160×80 RGB565 frame = 25 600 B = 50 chunks; a 150-frame animation is
  7 680 chunks ≈ 3.9 MB — expect ~4-8 minutes at vendor pacing; consider
  whether HallJoy should keep vendor pacing or go faster (device tolerance
  unknown).
- Time sync: send cmd 11 to the **keyboard** interface (wired only), format
  `"YYYY-MM-DD HH:MM:SS"` + `getDay()` week byte.

## 8. Unknowns / inferred items

- Screen interface report ID (assumed 6) and whether it has additional
  collections/interfaces — never enumerated live.
- Whether the device ACKs/NACKs image writes at all; JS never reads on `nn`.
- Frame interval units: `1000/fps` ms is inferred; device may interpret
  differently (e.g. centiseconds). Needs hardware test.
- Whether frame count >150 or interval edge values are accepted; UI caps are
  app-side only.
- Whether cmd 13 header/footer `byte7` (0x40/0x00) has additional meanings
  (e.g. clear-screen variant) — only two values ever sent.
- Resolution/color-depth negotiation: **none exists** — no command sets
  width/height/format; it is fixed by model catalog (default 160×80 RGB565).
  Other catalog screen sizes (128×128, 240×135, 240×240, 320×172, 428×142,
  170×320 per `Ha` map in device-info responses) are presumably also RGB565
  but only 160×80 and the 428×142 frame-cap branch are evidenced in code.
- Whether the separate screen device needs its own cmd-11 clock sync (the app
  only sends it to the keyboard).
- K98 Pro's actual panel resolution: catalog gives no width/height for the
  vid/pid-style `screen` field, so the editor defaults to 160×80 — the real
  panel may differ (K98 Pro product images suggest a small round/rect display;
  unverified).
- `he-webapp/` mirror (different vendor app) was not analyzed; may contain a
  second screen implementation.
