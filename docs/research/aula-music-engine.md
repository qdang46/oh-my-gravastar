# AULA Music engine teardown (`Aula-Music-Setup1.exe`)

Source: `https://app.aulacn.com/commonAssets/Aula-Music-Setup1.exe`
(referenced by the khub webapp's Rhythm page — `Rhythm-vX7LyrFn.js` —
as the Windows music plugin, launched via `bypc-MAxis://`).

NSIS installer, extracted with `7z` to `.tmp-aula-hub/` (gitignored
scratch dir in the repo root).

## Contents

| File | Size | Role |
|---|---|---|
| `XsEngine.exe` | 17 MB | Qt GUI shell — effect picker, device status. Imports `xseg.dll`. |
| `xseg.dll` | 975 KB | **The engine**: audio capture + effect actors + HID device comms. Exports actor-framework API; internals (ASEffect*, HIDCom) are not stripped of RTTI but methods are internal. |
| `hidapi.dll` | — | HID transport (same lib family we use). |

## xseg.dll architecture (from export table + strings)

Actor/message framework (`ea_mgr` = manager, `ea_actor` = actor base,
`ea_message` types, `call`/`send`/`dispatch`/`invoke`/`fork`/`timeout`).

- `AudioDataSource` — miniaudio (`ma_device`) capture; `captureCb`,
  `calcSample`, messages `MsgWatchAudio`/`MsgUnWatchAudio`/
  `MsgAudioData`/`MsgAudioDeviceStop`. Strings show full **WASAPI
  loopback** support incl. *process-specific* loopback (Win10 20348+),
  plus DirectSound/JACK backends (miniaudio backends).
- `ScreenDataSource` — `Screen_Capture::SL` screen sampling
  (`MsgWatchScreenSample`, `onScreenFrame`, `printFPS`) — separate
  screen-reactive path, not audio.
- `EffectMgr` — `createEffect(int kind, shared_ptr<ea_actor>, int, int)`
  returns an `ea_actor`; `effects()` → `vector<UEffectDesc>`;
  `setEffect(int)`, `curEffect()`. Disassembly of `createEffect`
  (RVA `0xdc70`, image base `0x180000000`): switch on a subtype arg —
  cases allocate ~0x698/0x6A8-byte actors with vtables in `.rdata`
  (`0x1800c0748`, `0x1800c0798`, `0x1800bf060`, …) or call factories at
  `0x180007480` / `0x180007250`. RTTI names: `ASEffect`, `ASEffect2`,
  `ASEffect3`, `ASEffect4`, `AudioEffect` — **four audio effects**.
- `DeviceMgrService` — `scanDevice`, `processDeviceOnline/Off`,
  `DeviceDesc` table, `findDevConf`/`findDevDesc` over **nlohmann::json**
  device config (`{"autoOpen":true,"mode":1}` / `"mode":3` seen),
  `MsgHIDParams`, `HIDCom` ([Info]/[Warring] log tags) — the HID link
  to the keyboard, via bundled `hidapi.dll`.
- `LightMatrixBox` (in XsEngine.exe) — UI-side light matrix preview.

## What this confirms

- Vendor music mode = **PC-side pipeline** exactly as our spec assumed:
  WASAPI loopback → DSP → per-key frames → HID feature reports.
- Audio capture is **miniaudio WASAPI loopback** (system audio), with
  per-process loopback option — matches our ScreenCaptureKit approach.
- Effects are `ASEffect1..4` + params via `MsgUpdateDeviceConfReq`
  (JSON device conf) — i.e. the khub webapp Rhythm page's
  `ChangeEffect{Mode:169..173,428}` likely maps to these actors through
  `bypc-MAxis://` IPC, not to firmware light modes.

## MusicMAxisPlug.unpacked.exe (webapp-downloaded helper)

The khub webapp downloads a second binary, `MusicMAxisPlug_v1-0-0-5.exe`
(UPX-packed Qt5, ~13 MB unpacked), which is the piece that actually runs
the rhythm modes on PC. Full RE notes live in the session artifacts
(`.tmp-aula-hub/re/`); key confirmed facts:

- **Effect factory** (`AudionTyp` → class): 168 `Dance_Soft`,
  169 `Dazzling_Rock`, 170 `Clouds_Rise_And_Snow_Fly`,
  171 `Light_Field_Change`, 172/175 `Gurgling_Stream`,
  173 `Blooming_Passion`, 174 `Sine`, **428 `Dynamic_Spectrum`** —
  matching the webapp's rhythm mode ids (168 was missing from the UI
  table; 180 = `closeAudioMode`).
- **Frame send** (`0x40F220`): 520-byte frame buffer. For the
  feature-report device class it writes an 8-byte header
  (`[0]=channel, [1..4]=08 00 00 01 (cmd 0x08), [5..6]=00 7A, [7]=01`)
  then `hid_send_feature_report` with the remaining **512 payload
  bytes = interleaved per-key RGB** at uint16 key offsets (≥8, `-1` =
  skip) from per-device `RowButton_*` ini tables. Same cmd-8 dialect
  as our `write_gif_frame`, though this app targets the Audion/MAxis
  family — byte-exact equivalence with K1 Pro is unverified.
- **DSP/render** (per `[18]` vtable slot, ~33 fps via `Sleep(30)`):
  memset frame → per-column spectrum value ×5.0 → per-column
  attack/decay (new>prev keeps, else `prev − 1.0`/frame) → write RGB
  for `intensity` keys per column, colors ×0.5. FFT is a radix-2
  complex FFT over the next-pow2 WASAPI buffer.
- **Per-device layout**: 8 embedded `Audion_Configs/*.ini` resources
  with `[Key_Columns]`/`[Key_Rows]`/`RowButton_N` lists and a 23×23
  uint16 key-offset spatial map per effect — i.e. vendor effects are
  **column/band shaped**, not free-form per-key like our mixer.
- **Control**: local `QWebSocketServer` (`LocalServer-%1`, dynamic
  port), JSON cmds `ChangeDevice`/`ChangeEffect`/`ChangeParam`/
  `GetSupportedEffects` — driven by the khub webapp Rhythm page;
  launch via `bypc-MAxis://`.

## Not yet extracted

- ~~Frame byte layout inside `HIDCom`~~ — resolved above for the
  MAxis helper (8-byte header + 512 B interleaved payload, cmd 0x08).
  The xseg.dll `HIDCom` send path is presumably the same dialect but
  was not disassembled.
- ASEffect DSP internals inside `xseg.dll` itself (the XsEngine
  variant) — Ghidra headless remains the next step if needed; the
  MAxis helper already gave us the mode table + frame format.
- `rhythmColorList` palettes are runtime config from the hub, not
  embedded — `ColorTyp` is an index into a per-device list.

## Related

- `docs/research/aula-hub-teardown.md` — AULA HUB Electron app (device
  config/UI; music lives in this separate engine + `Aula-Music-Setup1`).
- `docs/research/khub-webapp/Rhythm-vX7LyrFn.js` — vendor rhythm UI:
  6 modes (`169-173` named + `428` "dynamic spectrum"), color list,
  `bypc-MAxis://` plugin handshake.

## Layer-mixer engine (2026-11-25, reworked)

`crates/music/src/mixer.rs` is the default renderer behind
`omg kb916 light music --engine mixer` (`legacy` keeps the older
BeatViz/SpectrumViz/PulseViz path). It is a generic 126-slot additive
layer mixer:

- **Geometry** — per-slot `KeyPoint`s built from the device keymap
  (`kb916_music::key_cells`, x in key units / row in row units), with a
  21×6 `grid_geometry` fallback when the keymap can't be read.
- **Layers** — `solid`, `breathing`, `wave`, `starry`, `spectrum`,
  `ripple`, `pulse`, `rain`; the mixer sums each layer's per-slot RGB
  scaled by its level (`name=0.5` in `--effect` overrides the default).
- **Presets** — `PRESETS` names curated layer+palette scenes
  (`spectrum`, `equalizer`, `party`, `lava`, `rainstorm`, `starry`,
  `pulse`, `breathing`, `wave`, `spectrum-stars`); `--effect <name>`
  accepts a preset or a comma-separated layer list, `--palette auto`
  keeps the preset palette.
- **Feature feed** — `make_feat` applies AGC + `--sensitivity` once;
  beat = bass-onset rule OR'd with the dsp flux beat flag; palette hue
  drifts per-second (frame-rate independent).
- **Packing** — `pack_frame` emits planar or interleaved RGB per
  `--pixel-order`.

`--source system` now works on Windows too: WASAPI render-endpoint
loopback (`wasapi` crate, dedicated `omg-music-loopback` thread,
event-driven shared-mode capture, f32 stereo → mono) alongside the
macOS ScreenCaptureKit backend.

Offline contrast sim (kick every 0.5 s): pulse-only floor 0.08 /
peak 0.32, ripple-only 0.03 / 0.04, spectrum-only flat 0.12, mixed
floor 0.11 / peak 0.35 — versus the legacy BeatViz which bottomed at
~0.25 mean between beats. The pulse layer's `env > 0.02` hard gate
means true silence still renders all-black (unit-tested). Live
hardware verification pending — needs music playing through system
loopback.
