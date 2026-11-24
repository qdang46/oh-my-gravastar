# Music Reactive Lighting — feasibility research

Status: **cmd-8 transport implemented + live-verified animating LEDs;
`omg kb916 light music` audio-reactive pipeline landed (mic live-tested,
system loopback code-verified).** Date: 2026-11-24. Scope: GravaStar
khub916 (K1/K1 Pro/K1 Lite/K98), HE v2 keyboards, Compx mouse.

This document records what was verified, from which evidence, and what
remains unknown. It is the input for the shipped `omg kb916 light music`
feature (bead oh-my-gravastar-bp6).

## 1. How the official feature actually works

GravaStar's "Rhythm RGB" is **not** a keyboard-side effect. Evidence:

- The HubX webapp mirror (`docs/research/khub-webapp/Rhythm-vX7LyrFn.js`)
  contains only a shell page. It spawns a hidden iframe to the custom URI
  `bypc-MAxis://` (which launches the companion) and talks JSON commands to
  a **Web Worker** (`worker-Cq8d7OkP.js`, not in the mirror):
  `ChangeDevice`, `GetSupportedEffects`, `ChangeEffect`, `ChangeParam`.
- Download link in the page:
  `https://hubx.pro/static/AppDir/MusicMAxisPlug_v1-0-0-5.exe`
  (4 688 832 bytes, PE32 GUI, UPX-packed; unpacked = 12 910 528 bytes).

### MusicMAxisPlug.exe — static analysis (Ghidra 12.1.4 headless)

Binary obtained from the vendor URL above, unpacked with `upx -d`, analyzed
with Ghidra headless (`x86:LE:32:windows`). Findings:

- **Qt 5 application** (QWebSocket, QAudio, widgets). Strings show
  `WebSocketServer_Parse.cpp` — it runs a local WebSocket server and also
  accepts launch via the `bypc-MAxis` URI scheme. Port not yet recovered
  (runtime value, likely from `data.ini`).
- **Audio capture: WASAPI.** Imports/strings include `pAudioClient->
  GetMixFormat/Initialize/SetEventHandle/Start` — the classic
  event-driven capture loop used for **render-endpoint loopback**
  (system audio, no microphone). Class `QAudio_Dynamic_Spectrum` plus
  `QAudionDrawThread` (dedicated render/send thread).
- **Per-effect renderer classes**, one per Rhythm mode in the webapp's
  `rhythmList` (`index-cV1Bl4gC.js`):

  | mode id | webapp name | exe class |
  |---|---|---|
  | 169 | 光彩夺目-摇滚 | `QAudion_Dazzling_Rock` |
  | 170 | 光场变化-人声 | `QAudion_Light_Field_Change` |
  | 171 | 云起雪飞-常规 | `QAudion_Clouds_Rise_And_Snow_Fly` |
  | 172 | 溪水涛涛-常规 | `QAudion_The_Gurgling_Stream` |
  | 173 | 百花争艳-激情 | `QAudion_Blooming_Passion` |
  | 428 (0x1AC) | 动态光谱-常规 | `QAudio_Dynamic_Spectrum` |

  Plus `QAudioEffctBass`, `QAudio_Sine`, `QAudio_Dance_Soft` (the
  `rhythmColorList` "ColorTyp" 1–20 colour modes).
- **Config**: `/data.ini`, `:/Audion_Configs/%s.ini`, keys
  `AudioParam/SliderGain`, `AudioParam/SliderSmooth` — runtime DSP gain /
  smoothing are user-tunable, matching the "sensitivity/smoothing" checklist.
- **HID transport: hidapi** (`hid.dll`, `HidD_SetFeature`,
  `HidD_GetFeature`, `HidP_GetCaps`, `HIDClass`, `WriteFile`,
  `Send Feature Report DeviceIoControl/GetOverLappedResult`).
- **Wired path uses feature reports of 0x208 = 520 bytes** — byte 0 is the
  report ID (6 or 9 depending on device), bytes 1..519 the payload —
  identical envelope to our wired 916 transport. Verified in
  `FUN_00420b40`: it builds a 520-byte buffer whose body starts
  `82 01` = cmd 130 device-info, embeds the 6-byte device UUID, sends via
  `hid_send_feature_report`, and parses the UUID reply — the same
  identify handshake as `docs/protocol-khub916.md` §4.
- **`ChangeDevice` accepts `ConnectType: "Wired"|"Wireless"`** — the
  companion handles both transports (the 20-byte init/poll branch in
  `FUN_00420b40` is consistent with the 19-byte wireless report format).
- **Frame streaming**: a timer-driven pump (`FUN_0040d1f0`-region tick)
  calls a per-effect virtual render→send; mode `0x1AC` (428, dynamic
  spectrum) is special-cased. The draw thread name `QAudionDrawThread`
  confirms continuous frame production. **The exact frame packet format
  (command id / layout) was not recovered** — the packet objects are built
  by the effect classes and dispatched through an internal queue
  (`FUN_00409970`), so the wire encoding needs either more RE time or a
  USB capture on Windows.

## 2. What the khub916 protocol already gives us

From `docs/protocol-khub916.md` (live-verified on K1 Pro, wired):

| command | payload | candidate role |
|---|---|---|
| 4 | ~128 B profile blob (light mode/speed/bright per mode) | select rhythm mode (169–173/428) + colour params — exactly what the companion's `ChangeEffect`/`ChangeParam` do at the config level |
| 6 | 378 B = 126×R + 126×G + 126×B | per-key static colours |
| 8 (`setGifLight`) | 512 B packets, 378 B data each, header `[8,0,0,1,0,122,1]` | **prime suspect for live frames**: 378 B = 126 keys × RGB — one full-keyboard frame per packet; vendor chunks an arbitrary byte stream, i.e. it can carry N frames back-to-back |
| 10 | ~483 B light-data blob (23 mode colour groups) | per-mode base colour (what `ChangeParam` colour writes likely use) |

The companion does **not** contain the literal cmd-8 header bytes
`08 00 00 01 00 7A 01` (searched the unpacked binary) — either it builds
packets byte-wise, uses a different command, or reuses the web driver's
code path with different constants. This is the main open question.

## 3. Other device families

- **HE v2 keyboard** (`crates/proto-he`, ported from orbit): lighting is
  zone-based — 3 zones (Keys / side bar / indicator), each with preset
  effect modes + an 8-colour palette (`LightingBase`, `set_palette`).
  No per-key RGB write exists in the protocol. Music-reactive on HE is
  therefore limited to coarse effects: map bass/mid/treble to zone colour
  index or mode changes. Feasible but far less impressive.
- **Compx mouse**: not assessed for this feature; mouse lighting is
  almost certainly zone/preset-based like HE. Low priority.
- **K98 Pro screen**: separate HID interface (GIF editor, cmd 11–13);
  unrelated to keyboard backlight streaming.

## 4. Audio capture feasibility (our own implementation)

The vendor proves WASAPI loopback works on Windows. Native options per OS:

| OS | mechanism | notes |
|---|---|---|
| Windows | WASAPI render-endpoint loopback (`IAudioClient` + `AUDCLNT_STREAMFLAGS_LOOPBACK`) | Rust: `wasapi` crate; no extra software |
| macOS | CoreAudio process tap (macOS 14.4+) or ScreenCaptureKit audio | no microphone permission needed for process tap |
| Linux | PipeWire/PulseAudio monitor source | `pipewire` crate or `parec`-style |

DSP is standard: windowed FFT (e.g. `rustfft`), band energies
(bass/mid/treble), simple onset/beat detection, attack/decay smoothing —
all CPU-trivial at 30–60 fps frame rates.

## 5. Throughput estimate (wired 916)

- One feature report = up to 519 payload bytes. If cmd 8 carries one
  378-byte RGB frame per report, a single report per frame gives 126-key
  RGB at whatever rate the firmware accepts — likely ≥30 fps; needs the
  live test in §6.
- Vendor pacing for screen uploads is 30–50 ms/chunk; keyboard-light
  writes may tolerate much faster. USB full-speed interrupt/feature
  latency is not the bottleneck; firmware buffer depth is the unknown.
- Wireless 916 (19-byte reports, 14-byte chunks) would need ~28 reports
  per 378-byte frame — probably too slow for smooth streaming; treat
  wireless as out of scope initially.

## 6. Blocking unknown → TEST-001 result (2026-11-24, K1 Pro wired)

**TEST-001 partially done.** `omg kb916 light stream` +
`crates/proto-khub916/examples/gif_probe.rs` now implement and live-probe
the vendor cmd-8 path (`Ht.setGifLight`: flat stream → 378-byte chunks →
`[8,0,0,1,0,122,1]` + data at offset 7, fire-and-forget, ~30 ms cadence).

- The device **answers** cmd 8: echoed header + a 385-byte reply whose
  378-byte payload is a static key/position table (identical for all
  frame colours — not a frame echo). See protocol-khub916.md "Cmd 8 live
  probe".
- Sustained streams at 30 fps and 50 fps ran clean (≤361 frames per run);
  writes are fire-and-forget so acceptance is inferred, not ACKed.
- **LED response confirmed** (2026-11-24, K1 Pro wired): streamed frames
  visibly animate the backlight; the planar `[R×126][G×126][B×126]`
  layout (cmd-6 order) is the working frame format — still technically
  unverified since no read-back exists, but patterns render correctly.
- Still open: whether a light mode must be active for cmd-8 to show
  (streams animate with the mode left as-is), and max sustained rate.

Next step if LEDs respond: `omg kb916 light stream --pattern rainbow`
is the demo; `--file -` accepts raw 378-byte frames on stdin for a future
capture→DSP→frames pipeline. If LEDs do *not* respond, finish reversing
the companion's frame-send function (Ghidra project at /tmp/maxis is
throwaway — re-import exe) or USBPcap the official Rhythm app on Windows.

Secondary unknowns: whether the device needs a "music mode" profile
active to accept streams; max sustained rate before dropped/mangled
frames; behaviour on disconnect (must restore prior lighting — the CLI
already snapshots profile + light-data and restores verified on exit).

## 7. Recommended architecture (if TEST-001 passes)

```
omg music start [--effect spectrum|bass-pulse|beat|wave]
              [--source system|mic] [--fps N] [--yes]
```

- New crate `crates/proto-music` (DSP + frame renderer, pure, testable)
  or extend `omg-model`; HID writes stay in `proto-khub916`.
- `omg audio` daemon mode or long-running `omg music run` process:
  capture thread → FFT/bands → renderer → rate-limited khub916 writer.
- Safety contract compliance: `--yes` required; print the exact change;
  snapshot current profile/light state on start and restore on stop or
  error; rate-limit writes; `--json` status output.
- Web/Music Studio UI stays out of scope until the CLI path is proven.

## Evidence index

- `docs/research/khub-webapp/Rhythm-vX7LyrFn.js` — Rhythm page shell,
  `bypc-MAxis://`, MusicMAxisPlug download URL, command names.
- `docs/research/khub-webapp/index-cV1Bl4gC.js` — `rhythmList`,
  `rhythmColorList`, `dtgpMode:428`, `closeAudioMode:180`.
- `MusicMAxisPlug_v1-0-0-5.exe` (vendor download, unpacked with UPX,
  Ghidra headless analysis) — Qt/WASAPI/hidapi/feature-report evidence;
  analysis artifacts were in `/tmp/maxis/` (throwaway).
- `docs/protocol-khub916.md` — cmd table, live verification log.
- `crates/proto-khub916/src/light.rs`, `crates/proto-he/src/lib.rs`,
  `crates/model/src/lib.rs` — implemented lighting surface.

## 8. Post-implementation findings (live runs, 2026-11)

- **Vendor report cadence**: khub916 feature reports in the Hub webapp are
  queued with `delay(200)` between tasks (`index-M8-m9qFR.deob.js`
  `processQueue`) ≈ **5 reports/s** — far below the 30 fps we originally
  streamed. Sustained high-rate cmd-8 traffic correlates with a firmware
  wedge (lighting stuck, Fn combos dead; see AGENTS.md incident log).
  `light stream`/`light music` now default to 10 fps and warn above 10.
- **Restore hazard**: the snapshot/restore path writes back whatever the
  profile held at start. If a previous run was killed mid-stream the
  device can sit in a GIF/leftover state that then gets snapshotted and
  restored forever. Both commands now warn when the snapshot decodes to
  mode 0 (off) or fails to decode.
- **Beat Motion Engine** (`crates/music`, `BeatViz`): spectral-flux
  onset detection classifies kick/snare/hi-hat; impacts are
  frame-count based and now scaled by `30/fps` (`FrameParams::fps`) so
  wall-clock timing is stable at any stream rate. Live-verified: beat
  events fire on real music, restore verified on exit.
- **Side LEDs are not reachable**: the khub916 protocol and vendor GIF
  editor only cover the 126 key LEDs; wing/side lighting is
  firmware-local (Fn combos) with no wire command found.
