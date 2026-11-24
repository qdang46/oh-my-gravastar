# UI/UX Spec

Target: 7 areas, two modes, one engine (`docs/vision-full-custom.md` §"Target
UI"). Current app: Vite+TS+WebHID PWA, vendor-clone dark shell, khub916-only,
pages `lighting · keys · macro · advanced · device` + secondary
`basic · config · rhythm · setting` (`web/src/pages.ts:33-46`).

## 1. Design principles

- **Capability-driven**: every control is gated by the capability registry —
  unsupported features are hidden in Simple mode, shown disabled-with-reason
  in Expert mode. K1 Pro must never offer actuation/RT/DKS/calibration.
- **One engine**: Simple and Expert modes render the same feature modules
  and the same transaction executor; mode only changes density/labels, never
  code paths.
- **Preview before write**: every mutation shows a structured diff and
  recoverability note before approval (SAFETY-SPEC §4).
- **Honest status**: "sent, not confirmed" is a first-class state
  (already used in `advkeys.ts`); never fake success.
- **No native dialogs**: replace all `window.confirm`/`window.prompt`
  (currently in `macro.ts:279,649,696,768`, `advkeys.ts:496,610`; lighting
  has its own confirm flow `lighting.ts:927`) with the modal spec in §6.
  Bead `sfa`.

## 2. The 7 areas

### 2.1 Dashboard (new — bead `utk`, P3)

Device card (model, firmware, battery, link type), current lighting mode,
quick actions (change effect, backup, music mode), health hints, recent
changes (audit-log tail). Landing candidate — evaluate vs current
lighting-first default.

### 2.2 Keymap Studio (evolve `remap.ts` + `keyboard.ts` + `keypool.ts`)

Existing: visual 87-key K1 Pro layout (`k1pro-layout.ts`), 217-key pool,
4-layer tabs, staged edits, dup warning.
Add: layer manager (rename not possible — firmware-fixed; show/hide, per-layer
dirty state), undo/redo stack, keypool search by name **and** HID/usage,
reset-key/reset-layer actions, multi-select apply, diff preview on Apply,
combo/shortcut placeholder section gated by capability (all `[missing]`
today — see FEATURE-INVENTORY A–D).
Bead `c8y`.

### 2.3 Lighting Studio (evolve `lighting.ts`)

Existing: 18-mode grid, speed/brightness, HSV `ColorPicker`, per-key RGB,
presets, JSON apply with confirm.
Add: named scenes (save/load/delete localStorage, export/import) — bead
`nha`; music-reactive page (FFT→cmd-8 frames, level meter, auto-restore) —
bead `8r8` (in progress); scene = full config (mode+speed+brightness+
colors), not just RGB lists.

### 2.4 Performance Studio (new, HE-only — bead `xp0`, P3)

Actuation/RT/deadzone per-key editor, DKS/MPT/SOCD/RS controls, live travel
monitor, calibration wizard. **Entire area hidden unless capability
registry says HE device.** Requires WebHID transport for `0xFFB0` in web
(`web/src/hid.ts` is khub916-only today).

### 2.5 Macro Studio (evolve `macro.ts`)

Existing: macro list, step editor (delay/key/up), tag-3 key binds, save-all.
Add: timeline visualization, validator warnings (missing release, stuck
modifier, overlong delay, 512 B overflow, unsupported keycode), duplicate,
search/replace — bead `uol`. Recording/host-input capture remains `[missing]`
(needs input-report path; investigate feasibility, else document as
CLI/firmware-only).

### 2.6 AI Assistant (new — bead `7js`, P4)

Panel: NL request → ops (AGENT-ARCHITECTURE §5) → diff preview → approve →
execute → verify report. "Explain my keyboard" view (§5 of that doc).
Rule-based parser first; LLM optional later, always through the same
planner/validator/executor.

### 2.7 Profiles & Safety (evolve `pages-secondary.ts` config page)

Existing: snapshot JSON export/import (`snapshotToJson`), profile import
with device matching.
Add: auto-snapshot before every write, version history, compare, section
restore, rollback — bead `th0`; import validation hardening — `y6s`;
permissions/activity log view (audit-log.ts); diagnostics page (key test,
matrix, chatter — L0 only) — bead `oq2`.

## 3. Simple vs Expert mode

| | Simple | Expert |
|---|---|---|
| Audience | non-technical | power users |
| Keymap | click key → pick from illustrated common keys; presets | full 217-pool + raw u32 + HID usage |
| Lighting | scene picker, sliders in plain words | mode ids, JSON editor, per-slot RGB |
| Macro | templates + guided step builder | raw action grammar `delay:key:up` |
| Behaviors | "tap = do X, hold = do Y" one-action flow | timing/conditions/raw params |
| Protocol | never shown | command IDs, report hex, verification level |
| Agent | guided NL + explanations | plan JSON, op schema, execution log |
| Safety | plain-language impact ("keyboard will restart") | policy class L0–L4, journal entries |

Rule: **same components, same engine** — mode is a view-model transform +
CSS density, not separate pages. Default = Simple; choice persisted.

## 4. Component inventory → existing files

| Component | File | Notes |
|---|---|---|
| App shell / sidebar nav | `web/src/shell.ts`, `pages.ts` (`NAV_PAGES`) | add Dashboard + Assistant entries |
| Shared state / snapshot | `web/src/state.ts` | **split** into device/draft/execution per vision §9 |
| HID transport | `web/src/hid.ts` (`Khub916Session`, `requestKhubDevice`) | write-policy boundary; add HE `0xFFB0` for `xp0` |
| khub916 codec | `web/src/proto/khub916.ts` | codec only — no UI logic (keep) |
| light codec | `web/src/proto/light.ts` | cmd-10 light-data write |
| advkey codec | `web/src/proto/advkey916.ts` | cmd 18 path |
| macro codec | `web/src/proto/macro916.ts` | region assembly |
| Keyboard visualizer | `web/src/keyboard.ts` + `k1pro-layout.ts` | physical truth |
| Key pool/labels | `web/src/keypool.ts` | add search (c8y) |
| Remap page | `web/src/remap.ts` | staged edits; add undo/redo |
| Lighting page | `web/src/lighting.ts` | 1151 lines — candidate to split scene/editor |
| Macro page | `web/src/macro.ts` | replace native dialogs |
| Advanced page | `web/src/advkeys.ts` | honest unconfirmed-state UI exists |
| Secondary pages | `web/src/pages-secondary.ts` | basic/config/rhythm/setting; profile import lives here |
| Styles | `web/src/style.css`, `remap.css` | vendor dark + lime; modal styles go here |

New modules (vision §9): `core/`, `safety/`, `agent/`, `features/*`,
`ui/components|layouts|design-system` — build interfaces + tests first,
migrate gradually.

## 5. Modal / dialog spec (replaces native confirm/prompt)

One reusable component (`ui/components/ConfirmModal.tsx`-equivalent in TS):

- **Content**: what will be written (structured diff, not raw JSON by
default — JSON behind "Expert details"), which keys/regions affected,
  overwrite warning if snapshot exists, recoverability line
  ("you can undo this from Profiles & Safety"), policy class badge
  (L2/L3), for L3 the impact explanation ("keyboard restarts, ~5 s").
- **Actions**: Cancel (default focus) / Confirm (destructive styling for
  overwrites). L3 requires typing nothing but a *second* distinct confirm
  step — never a single click.
- **Prompt replacement** (e.g. macro name `macro.ts:279`): inline input
  inside the same modal component, not `window.prompt`.
- **Async writes**: modal shows progress → result (verified / sent-unconfirmed
  / failed-partial) inline; stays open on failure with error detail.
- **Accessibility**: focus trap, Esc = cancel, `role="alertdialog"`.

## 6. Per-operation feedback + activity log

- Every write surfaces a result toast **and** a journal entry:
  `{time, op summary, device, verified, snapshot_id}`.
- Status vocabulary (already partially used): `verified` ·
  `sent, not confirmed` · `failed` · `partial (sections: …)` ·
  `cancelled`.
- Activity log lives in Profiles & Safety (audit-log.ts) and feeds
  Dashboard "recent changes"; exportable as part of profile JSON.
- Auto-reconnect (R6): banner naming the reconnected device; queued writes
  are dropped, never silently replayed.

## 7. Layout shell

Keep vendor-clone sidebar (5 primary + Device submenu) until Dashboard
proves better in review; new areas slot in as: Dashboard (home), Keymap,
Lighting, Macro, Performance (gated), Assistant, Device/Profiles & Safety.
Routes stay hash-based (`pages.ts` `pageFromHash`) for PWA deep links.
