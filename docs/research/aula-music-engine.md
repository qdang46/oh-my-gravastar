# AULA Music engine teardown (`Aula-Music-Setup1.exe`)

Source: `https://app.aulacn.com/commonAssets/Aula-Music-Setup1.exe`
(referenced by the khub webapp's Rhythm page — `Rhythm-vX7LyrFn.js` —
as the Windows music plugin, launched via `bypc-MAxis://`).

NSIS installer, extracted with `7z` to `/tmp/aula_music/` (volatile).

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

## Not yet extracted

- Frame byte layout inside `HIDCom` (planar vs interleaved, header) —
  needs disassembly of the HIDCom send path (not exported; locate via
  xrefs to `hid_write`/`hid_send_feature_report` imports).
- ASEffect DSP internals (FFT size, bands, beat detector, per-effect
  shaders) — each is a few-KB function cluster; objdump-level RE is
  possible but slow; Ghidra headless on `xseg.dll` is the next step.
- `MusicMAxisPlug_v1-0-0-5.exe` (hubx.pro, ~4.7 MB, UPX) — the Windows
  audio-capture helper the webapp downloads; still downloading at time
  of writing (`/tmp/MusicMAxisPlug.exe`).

## Related

- `docs/research/aula-hub-teardown.md` — AULA HUB Electron app (device
  config/UI; music lives in this separate engine + `Aula-Music-Setup1`).
- `docs/research/khub-webapp/Rhythm-vX7LyrFn.js` — vendor rhythm UI:
  6 modes (`169-173` named + `428` "dynamic spectrum"), color list,
  `bypc-MAxis://` plugin handshake.

## F75 layer-mixer port (2026-11-25)

The macOS reference (`raghavt20/aula-f75-macos`, MIT) was ported into
`crates/music/src/f75.rs` as `VendorEngine` and exposed via
`omg kb916 light music --engine f75` (`--effect` = comma-separated
vendor layer list, `--palette`, `--speed`). Layers: solid, breathing,
lave, starry, spectrum, ripple, pulse, rain — mixer sums per-layer
renders scaled by vendor `defaultLevel`, beat rule = vendor bass
threshold OR'd with our flux beat. Frames are interleaved LED×RGB
(`led = col*6+row` on the F75 map); `--pixel-order planar` converts
back for the K1 Pro slot order.

Offline contrast sim (`cargo run -p omg-music --example f75_sim`,
kick every 0.5 s): pulse-only floor 0.08 / peak 0.32, ripple-only
0.03 / 0.04, spectrum-only flat 0.12 (bands held constant), default
pulse+ripple floor 0.11 / peak 0.35 — versus the legacy BeatViz
which bottomed at ~0.25 mean between beats. The pulse layer's
`env > 0.02` hard gate means true silence still renders all-black
(unit-tested). Live hardware verification pending — needs music
playing through system loopback.
