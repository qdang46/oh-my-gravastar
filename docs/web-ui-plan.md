# Web UI clone plan — GravaStar 1khub configurator

Scope: `web/` (Vite + vanilla TS + WebHID PWA, read-only khub916 wired scaffold)
cloned to *feel* like the vendor configurator at
<https://support.gravastar.com/1khub/> with a better visual style.
Vendor JS reference: `docs/research/khub-webapp/` (mirrored minified source).
Protocol spec: `docs/protocol-khub916.md`; Rust reference:
`crates/proto-khub916`, CLI mirror: `crates/omg` (`omg kb916 …`).

## 1. Template / style source (open-design.ai assessment)

**`open-design.ai/templates` is not usable for this task.** It is the
OpenMotion catalog: 345 *video* templates (Motion.md remixes for launch
videos, promos, intros). None produce a web-app UI.

**`open-design.ai/systems` is usable** — a catalog of ~278 design-system
guides, each with a 56-token contract (surface/text/border/accent/semantic,
type scale, spacing, radius, elevation, focus ring, motion, layout) plus a
`DESIGN.md` an agent can consume. Relevant entries:

- **Cosmic** (`/plugins/design-system-cosmic/`) — dark sci-fi, neon purple
  accent `#c084fc` on `#070711`/`#111126`, Inter + mono, radius 10–24 px,
  150/240 ms motion. Closest match to a dark gaming-hardware configurator.
- **Cursor** (`/plugins/design-system-cursor/`) — warm minimalism, orange
  accent `#f54e00`; its token *structure* (oklab borders, 8 px base scale,
  pill radii) is a good reference even though its surfaces are light.
- **Radix Themes** (`/design-system/radix-themes/`) — real 9-chapter guide
  with `--accent-1…12` / `--gray-1…12` role scales and a downloadable
  DESIGN.md; best *component-state* reference (hover/selected/disabled).
- **Skeumorphism** — hardware-metaphor styling but light/warm; rejected.

**Decision: no off-the-shelf template fits.** Recommend a **custom dark
theme that keeps the vendor's layout/function but upgrades its styling**,
using the vendor palette as the base and the open-design token contract
(Cosmic structure + Radix state model) as the upgrade reference:

| Token | Vendor-derived value | Note |
|---|---|---|
| `--bg` | `#0b0d0e` (near vendor `#080A0A`) | page background |
| `--surface` / `--surface-2` | `#14171a` / `#1d1d20` (vendor `#1d1d20`,`#282828`) | panels, sidebar, key caps |
| `--fg` / `--fg-2` / `--muted` | `#EDF0EF` (vendor icon/text colour) / `#aab3ad` / `#6b7570` | text ramp |
| `--border` | `rgba(237,240,239,0.10)` | hairlines (oklab-style alpha) |
| `--accent` | `#1890ff` (antd blue the vendor inherits) — optionally shifted toward vendor cyan/white for "GravaStar" feel | primary action, active nav |
| `--success/--warn/--danger` | `#39ff88` / `#fff34d` / `#ff4d8d` (Cosmic semantic set) | status, warnings |
| spacing | 4 px base (`--space-1…9` = 4/8/12/16/24/32/40/48/64) | Cosmic scale |
| radius | `--radius-sm 8 / md 12 / lg 16 / pill 9999` | between vendor's sharp and Cosmic's round |
| type | Inter or system-ui; mono `SF Mono/ui-monospace` for hex/UUID/key values | vendor uses a plain sans |
| motion | 150 ms fast / 240 ms base, `cubic-bezier(0.2,0,0,1)` | Cosmic |
| focus | `0 0 0 4px rgba(accent,0.32)` ring | accessibility |

Bead: `oh-my-gravastar-s9d` owns the token sheet + primitives.

## 2. Vendor UI structure (from mirrored JS)

- **Shell** (`MainLayout-D43lXfqC.js`): header (logo + language dropdown
  en/zh + config entry), collapsible left **sidebar** listing device
  product name and nav items; tooltips when collapsed; mobile <768 px
  auto-collapse.
- **Menu** (`ke` map): `lightingEffect`, `basicChangeKeyCode`,
  `macroConfiguration`, `advancedKey`, `basicFunctions`, `deviceOverview`,
  `configurationManagement`, `rhythm`, `setting`, `gifEdit` — routes under
  `/keyboard/<page>`.
- **Device layer** (`screensInit`, `deviceAdapter`, `index-M8-m9qFR.js`):
  WebHID `requestDevice`/`getDevices` filtered by VID/PID; picks the
  collection with `featureReports>0 && inputReports>0 &&
  usagePage>=0xFF00`; `reportId` from the first feature report; 519-byte
  payload buffer; queued `sendCommand`/`sendReport` with checksum
  (sum & 0xFF) and input-report listeners; per-device stores (Pinia)
  persisted to localStorage (`machine:device-lighting-cache`,
  `machine:appearance-cache`, `machine:tenant-id`).
- **Backend**: only `https://api.hubx.pro` for site appearance/tenant —
  all device I/O is WebHID. Our clone needs **no backend**.
- **Keyboard renderer** (`Keyboard-BorsRmvc.js` + `keyShape-Cg2XF5JY.js`):
  **DOM grid**, not canvas/SVG — one absolutely-positioned `<div>` per key
  block, geometry from `keyShape` in rem units scaled by a layout
  constant; per-key `background: rgb(r,g,b)` from cmd134 colours and
  auto black/white legend via luminance `0.299r+0.587g+0.114b`;
  click/contextmenu per key; K98 Pro gets a product PNG background +
  "key cover" cutout rect and a screen-overlay region
  (`{x:753,y:2,w:166,h:42}` rem). `BasicFunctions` has an SVG polygon
  `KeyShapeEditor` (drag handles on normalized 0–1 points).
- **Color picker** (`LightingEffect` page): canvas SV square + hue slider
  + hex/RGB inputs + HSV↔RGB conversion — all portable pure functions.
- **Sliders**: `VerticalSlider` custom component; speed/brightness range
  0–20 (vendor limit).
- **Key table** (`index-M8-m9qFR.deob.js`): `qe()` string table + `Ca[]`
  `{value,name}` pairs cover HID usages incl. mouse buttons, consumer
  keys (volume/brightness/media), system keys (LWin combos), F-keys,
  `SOCD`/`TGL`/`MT` markers — port the needed subset.

## 3. Page-by-page plan

| # | Vendor page | Bead | Proto/CLI endpoints needed |
|---|---|---|---|
| 0 | — | `oh-my-gravastar-s9d` P2 | design tokens + primitives (no device I/O) |
| 1 | Shell/nav/connect | `oh-my-gravastar-euw` P1 | `hid.ts` requestDevice/filters; `Khub916Session` info (cmd130/131), `power` (135) for header status |
| 2 | Keyboard visualizer | `oh-my-gravastar-k00` P1 | `keymap(layer,system)` cmd3-read, `custom_light_colors` cmd134 → per-key RGB; keyShape geometry table port |
| 3 | Lighting (`lightingEffect`) | `oh-my-gravastar-far` P1 | read: `profile` cmd132 (mode/speed/bright), `custom_light_colors` cmd134, `light_color_data` cmd138 (raw until 49w); write: `Profile::with_light_mode`/`with_sleep_seconds` → `write_profile` (cmd4) = `omg kb916 set light-mode|sleep --yes`; `write_custom_light_colors` (cmd6) = `omg kb916 set light-color`; per-mode JSON effects blocked on `oh-my-gravastar-49w` |
| 4 | Keys remap (`basicChangeKeyCode`) | `oh-my-gravastar-28d` P1 | read `keymap` (cmd3, args layer 0–3 / system bit); write `write_keymap` cmd3 tags 248/1, 128-slot zero-pad + `5A A5`, read-back verify = `omg kb916 set key|keymap --yes` |
| 5 | Macro (`macroConfiguration`) | `oh-my-gravastar-ae3` P2 | read `macro_region` cmd133 (currently raw — decode is part of this bead); write blocked on `oh-my-gravastar-abo` (cmd3 macro path + `omg kb916 macro`) |
| 6 | Advanced keys (`advancedKey`) | `oh-my-gravastar-0um` P2 | blocked on `oh-my-gravastar-2ic` (cmd18 wired / cmd82 wireless, MT/SOCD/TGL read+write+verify, `omg kb916 adv get/set --json`) |
| 7 | Overview/basic/config stubs | `oh-my-gravastar-jwb` P3 | overview: existing reads; basicFunctions: `write_profile` cmd4 (sleep, polling-rate-adjacent fields); configManagement: profile blob export/import JSON (TS port of `omg profile export/import`) |

Out of scope: `rhythm` (MusicMAxisPlug external exe), `gifEdit`/screen
push (separate screen HID interface `0x258A:0x01B4`,
`docs/protocol-khub916-screen.md`), wireless `916_wireLess` transport
(19-byte output reports — separate bead, currently refused in
`web/src/hid.ts`/`omg`).

## 4. Suggested build order

`s9d` (tokens) → `euw` (shell) → `k00` (visualizer) → `far` + `28d`
(lighting, keys — the two pages users touch most) → `ae3`/`0um` once their
protocol beads land → `jwb` polish.
