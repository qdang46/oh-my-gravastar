# AULA HUB 1.1.22 — official Windows driver teardown (WIP)

Source: `AULA HUB.zip` → NSIS installer → `app-64.7z` → Electron app
(`app.asar` extracted with `@electron/asar`). Extraction was done under
`/tmp/aula_hub/` — **volatile, re-extract if gone**:

```sh
unzip "AULA HUB.zip" -d /tmp/aula_hub
7z x "/tmp/aula_hub/AULA HUB/Aula Hub Setup 1.1.22.exe" -o/tmp/aula_hub/extracted
7z x "/tmp/aula_hub/extracted/\$PLUGINSDIR/app-64.7z" -o/tmp/aula_hub/extracted/app
npx @electron/asar extract resources/app.asar app_extracted
```

## What is inside

- `dist-electron/main.mjs` + renderer bundle `dist/assets/index-npIkQlTa.js`
  (~2.4 MB, **obfuscated** — string-table indirection, class names mangled).
- Keyboard SDK deps (package.json): `@bytech/web-hid-sdk`,
  `@bytech/web-sdk-machine`, `@hfd-sdk/keyboard-sdk` — bundled into the
  index asset; `node_modules` is NOT shipped unpacked.
- Candidate protocol files (small, readable-ish):
  - `dist/assets/hfd-sdk.es-CwIM3CGY.js` (41 KB, has `setGifLight`)
  - `dist/assets/HFD-DSWOC1e8.js` (60 KB, two `378` literals)
  - `dist/assets/gifLight-*.js`, `light-*.js` — mostly UI/config;
    `light-Cp389CIy.js` references `musicRhythm` →
    `Aula-Music-Setup1.exe` download (music mode may be a separate
    helper app, not in this bundle!).
- `resources/aula-gsi/` — Python 3.13 sidecar (`aula-gsi.exe`, CS2 GSI
  config) — game integration, probably unrelated to keyboard LEDs.
- `resources/headset/` — headset audio drivers (cmhidra.dll etc.), unrelated.

## Open questions for next session

1. Does music-reactive lighting live in `Aula-Music-Setup1.exe` (separate
   download) rather than this Hub? If so, fetch that installer instead —
   it likely contains the real FFT/beat code + frame writer.
2. If in this bundle: deobfuscate `index-npIkQlTa.js` enough to find the
   cmd-8/frame writer (search `setGifLight`, `378`, report-id `0x06`).
3. Cross-check the F75 spec's interleaved `led*3` layout and
   `col*6+row` LED map against whatever the SDK actually sends — the
   pending single-byte probe on the user's device (planar key74-green vs
   interleaved LED66-blue) still needs a visual answer.

## Status

- Extraction + triage done; protocol code not yet located in bundle.
- Related: `docs/research/music-reactive-feasibility.md`, AGENTS.md
  incident log (khub916 cmd-8 wedge — respect fps limits).
