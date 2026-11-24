# khub916 lighting JSON schema — `omg kb916 light`

Agent-facing schema for `omg kb916 light get --json` (decoded state) and
`omg kb916 light apply <file.json> --yes` (writes). Wire details:
`docs/protocol-khub916.md` §6; vendor source:
`docs/research/khub-webapp/` (`LightingEffect-*.js`,
`deviceAdapter-*.js`, `index-cV1Bl4gC.js`, `index-M8-m9qFR.deob.js`).

**Transport:** wired 916 only (the CLI refuses `916_wireLess` like every
other `kb916` command). All writes are fire-and-forget feature reports
followed by a read-back verify inside the proto crate; `apply` requires
`--yes` and validates the whole config *before* the first byte is sent.

## What the device stores

| Concept | Where | Wire command |
|---|---|---|
| Current effect mode (u16) | profile `raw[9..11]` | read 132 / write 4 |
| Per-mode speed + packed type | profile record table past first `FF FF`: bright at `base+2m-2`, packed `(speed&15)<<4 | typeCode` at `base+2m-1`; modes `0,19,275,277` have no record | read 132 / write 4 |
| Per-mode RGB colour | light-data blob, 21-byte group per mode id at `mode*21`, bytes 0-2 = RGB | read 138 / **write 10** |
| Per-key custom colours | 126 entries × R/G/B planes (`pos = 8 + index*4`) | read 134 / write 6 |

- `typeCode`: `0` = monochrome single colour (`color_model` 1), `7` =
  colour mixing (`color_model` 2, firmware palette).
- The 18 bytes after each group's RGB triple are a constant firmware
  template on the K1 Pro (all 23 groups identical); semantics unknown —
  `apply` never touches them (read-modify-write of the RGB triple only).
- Modes ≥ 23 and the special modes have no colour group; a monochrome
  `color` for such a mode is rejected before any write.
- Vendor effect table (`LIGHT_MODES` in `proto-khub916/src/light.rs`):
  `0` off, `1` always_on, `2` breathing, `3` dream_rainbow,
  `4` one_touch, `5` rain_walk, `6` color_wheel, `7` key_ripple,
  `8` stars, `9` snow_trace, `10` flowing, `11` wave, `12` shadow,
  `13` sine_wave, `15` windmill, `16` waterfall, `17` blooming,
  `277` custom (per-key colours, cmd 6). Ids not listed (e.g. 14, 18+)
  are still sent if given — the wire accepts any u16 bounded by the
  profile record table — but the CLI warns. Per-model UI exclusions
  (e.g. K1 Pro hides 2/5/6/9/10) are a vendor-app filter, not a wire
  limit.

## `light get --json` output (abridged)

```json
{
  "device": { "…": "…" },
  "light": {
    "mode": 15, "mode_name": "windmill",
    "color_support": 3,
    "speed": 4, "brightness": 10,
    "color_model": 2, "color_model_name": "mixing"
  },
  "light_data": {
    "bytes": 483, "group_stride": 21, "group_count": 23,
    "tail_len": 0,
    "groups": [ { "index": 0, "offset": 0,
      "color": {"r":255,"g":0,"b":0,"hex":"#ff0000"},
      "raw": "ff000000ff00…" } ]
  },
  "custom_colors": { "count": 126, "non_black": 0, "colors": [ … ] },
  "modes": [ { "id": 0, "name": "off", "color_support": 0, … } ]
}
```

## `light apply` config

Every field is optional; absent fields keep the current device value.
At least one of `mode`, `speed`, `brightness`, `color_model`, `color`,
`keys` must be present.

```json
{
  "schema": 1,

  "mode": 15,               // effect id, see table above
  "speed": 4,               // 0-20 (vendor limit; low nibble stored)
  "brightness": 10,         // 0-20 raw wire byte
  "color_model": 2,         // 1=monochrome, 2=mixing; default = mode's
                          // vendor default, else current
  "color": "#3366ff",       // monochrome colour — "#rrggbb", "rrggbb",
                          // "r,g,b" or {"r":n,"g":n,"b":n};
                          // requires color_model 1 (implied when absent)

  "keys": {                 // per-key colours → cmd 6 write
    "preset": "rainbow",    // "solid" | "gradient" | "rainbow"
    "color": "#ff0000",     // solid fill / gradient start (solid default #ffffff, gradient start #ff0000)
    "to": "#0000ff",        // gradient end (default #0000ff)
    "entries": [            // sparse overrides on top of preset/current
      { "index": 0, "color": "#00ff00" },
      { "pos": 12,  "color": {"r":0,"g":0,"b":255} }
    ],
    "colors": [ "#rrggbb", "… exactly 126 entries …" ]
  }
}
```

`keys.colors` (full explicit table) and `keys.preset` are mutually
exclusive in practice — `colors` wins if both are given (preset is
ignored). `entries` apply on top of whichever base was chosen (preset,
explicit list, or the device's current table when neither preset nor
colors is given).

### Preset semantics (generated client-side, 126 slots)

- `solid`: every slot = `color` (default `#ffffff`).
- `gradient`: linear RGB lerp `color`→`to` across slots 0..125.
- `rainbow`: HSV hue sweep `i*360/126`, full saturation/value — the
  "rainbow-per-key" effect.

## Examples

Solid red on every key, custom mode:

```json
{ "mode": 277, "color_model": 1, "keys": { "preset": "solid", "color": "#ff0000" } }
```

Monochrome blue breathing, speed 8, dim:

```json
{ "mode": 2, "speed": 8, "brightness": 5, "color_model": 1, "color": "#2244ff" }
```

Rainbow per key + restore speed only:

```json
{ "keys": { "preset": "rainbow" } }
{ "speed": 10 }
```

## Apply write order and verification

1. `keys` → cmd 6 custom colours (126-slot R/G/B planes), read-back via 134.
2. profile → cmd 4 (`with_light_mode`: mode bytes + per-mode record),
   read-back via 132.
3. `color` with `color_model` 1 → cmd 10 light-data write (group RGB at
   `mode*21`), read-back via 138.

Each step reports `{step, command, verified}`; a failed step does not
stop later independent steps but the command exits non-zero. The JSON
result includes `change` (from→to for every touched field) and `steps`.

Note: the vendor JS skips the profile write when `type==1 && color`
(only cmd 10 is sent — likely a vendor bug that would leave mode/speed
unchanged); `apply` deliberately sends **both**, each verified.
