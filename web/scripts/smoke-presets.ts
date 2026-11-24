/**
 * Node smoke test for `src/presets.ts` — the preset library (built-in
 * catalog validity, keymap-snippet validation, user store round-trips,
 * file import/export, compatibility checks). DOM-free; a memory
 * `localStorage` shim stands in for the browser store.
 *
 * Run: `npm run smoke` (node >= 22.18, native TS stripping).
 */

declare const process: { exit(code?: number): never };

import {
  BUILTIN_PRESETS,
  PRESET_STORAGE_KEY,
  deletePreset,
  getPreset,
  keymapValueLabel,
  listPresets,
  parsePresetFile,
  presetCompatibility,
  presetFileName,
  presetFileText,
  presetSummary,
  renamePreset,
  savePreset,
  validateKeymapSnippet,
  validatePresetConfig,
  type Preset,
  type PresetDraft,
} from '../src/presets.ts';
import { CUSTOM_LIGHT_SLOTS, LIGHT_MODES } from '../src/proto/light.ts';
import { decodeKeyValue } from '../src/proto/khub916.ts';
import { parseSceneConfig, sceneConfigToJson } from '../src/lighting-scenes.ts';
import { K1_PRO_LAYOUT_MODELS } from '../src/k1pro-layout.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── localStorage shim (store helpers resolve it lazily at call time) ──

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
};

// ── built-in catalog ───────────────────────────────────────────────────

section('built-in catalog');

check('catalog has lighting + keymap presets', BUILTIN_PRESETS.some((p) => p.kind === 'lighting') && BUILTIN_PRESETS.some((p) => p.kind === 'keymap'));
check('catalog size sane (5–12)', BUILTIN_PRESETS.length >= 5 && BUILTIN_PRESETS.length <= 12, String(BUILTIN_PRESETS.length));
check('ids unique', new Set(BUILTIN_PRESETS.map((p) => p.id)).size === BUILTIN_PRESETS.length);
check('all builtins flagged', BUILTIN_PRESETS.every((p) => p.builtin === true));
check('every preset has a target protocol', BUILTIN_PRESETS.every((p) => p.target.protocol === 'khub916'));
check('keymap presets marked experimental', BUILTIN_PRESETS.filter((p) => p.kind === 'keymap').every((p) => p.experimental === true));

for (const p of BUILTIN_PRESETS.filter((p) => p.kind === 'lighting')) {
  const cfg = p.config as ReturnType<typeof parseSceneConfig>;
  const roundTrip = parseSceneConfig(sceneConfigToJson(cfg));
  check(`${p.id}: scene config round-trips`, roundTrip.mode === cfg.mode && roundTrip.speed === cfg.speed);
  check(`${p.id}: mode in vendor table`, LIGHT_MODES.some((m) => m.id === cfg.mode), `mode ${cfg.mode}`);
  if (cfg.keys) {
    check(`${p.id}: 126 key slots`, cfg.keys.colors.length === CUSTOM_LIGHT_SLOTS);
  }
}

for (const p of BUILTIN_PRESETS.filter((p) => p.kind === 'keymap')) {
  const cfg = validateKeymapSnippet(p.config);
  check(`${p.id}: layer 0`, cfg.layer === 0);
  const indices = Object.keys(cfg.slots).map(Number);
  check(`${p.id}: slot indices in range`, indices.every((i) => i >= 0 && i < 128));
  check(`${p.id}: values decode`, indices.every((i) => decodeKeyValue(cfg.slots[i]!).kind !== 'unknown'));
}

// ── summaries / labels ─────────────────────────────────────────────────

section('summaries');

const gaming = BUILTIN_PRESETS.find((p) => p.id === 'builtin-light-gaming-red')!;
check('lighting summary mentions mode', /Breathing/i.test(presetSummary(gaming)), presetSummary(gaming));
const km = BUILTIN_PRESETS.find((p) => p.id === 'builtin-km-nav-home-end')!;
check('keymap summary counts bindings', presetSummary(km).includes('2 bindings'), presetSummary(km));
check('keymap value label resolves', keymapValueLabel(74).length > 0);
check('bare modifier label', keymapValueLabel(0x00010000).includes('Ctrl'), keymapValueLabel(0x00010000));

// ── keymap snippet validation ──────────────────────────────────────────

section('validateKeymapSnippet');

check('accepts minimal snippet', validateKeymapSnippet({ slots: { 3: 0x10000 } }).slots[3] === 0x10000);
check('defaults layer/system', (() => {
  const c = validateKeymapSnippet({ slots: { 0: 41 } });
  return c.layer === 0 && c.system === false;
})());
check('rejects non-object', throws(() => validateKeymapSnippet('x')));
check('rejects bad layer', throws(() => validateKeymapSnippet({ layer: 4, slots: { 0: 1 } })));
check('rejects slot 128', throws(() => validateKeymapSnippet({ slots: { 128: 1 } })));
check('rejects slot -1', throws(() => validateKeymapSnippet({ slots: { '-1': 1 } })));
check('rejects float value', throws(() => validateKeymapSnippet({ slots: { 0: 1.5 } })));
check('rejects > u32', throws(() => validateKeymapSnippet({ slots: { 0: 0x100000000 } })));
check('rejects empty slots', throws(() => validateKeymapSnippet({ slots: {} })));
check('rejects unknown tag', throws(() => validateKeymapSnippet({ slots: { 0: 0xff000001 } })));
check('validatePresetConfig dispatches', (() => {
  const c = validatePresetConfig('keymap', { slots: { 5: 20 } });
  return typeof c === 'object' && 'slots' in c;
})());
check('lighting kind uses scene parser', (() => {
  const c = validatePresetConfig('lighting', { schema: 1, mode: 2, speed: 1, brightness: 1 });
  return typeof c === 'object' && 'mode' in c && (c as { mode: number }).mode === 2;
})());

// ── user store ─────────────────────────────────────────────────────────

section('user preset store');

const draft: PresetDraft = {
  name: 'My Red',
  kind: 'lighting',
  description: 'test preset',
  target: { protocol: 'khub916' },
  config: { schema: 1, mode: 2, speed: 3, brightness: 7, color: '#ff0000' },
};

const saved = savePreset(draft);
check('save returns user id', saved.id.startsWith('user-'), saved.id);
check('save flags builtin false', saved.builtin === false);
check('save validates config', (saved.config as { mode: number }).mode === 2);

check('listPresets includes builtin + user', listPresets().length === BUILTIN_PRESETS.length + 1);
check('listPresets(kind=lighting) filters', listPresets('lighting').every((p) => p.kind === 'lighting'));
check('getPreset finds user', getPreset(saved.id)?.name === 'My Red');
check('getPreset finds builtin', getPreset('builtin-light-off')?.name === 'Lights Off');
check('unknown id → null', getPreset('nope') === null);

const renamed = renamePreset(saved.id, 'Renamed Red');
check('rename works', renamed.name === 'Renamed Red');
check('rename builtin throws', throws(() => renamePreset('builtin-light-off', 'x')));
check('rename unknown throws', throws(() => renamePreset('nope', 'x')));

check('delete user preset', deletePreset(saved.id) === true);
check('delete again → false', deletePreset(saved.id) === false);
check('delete builtin → false', deletePreset('builtin-light-off') === false);
check('store empty again', listPresets().length === BUILTIN_PRESETS.length);

check('save rejects empty name', throws(() => savePreset({ ...draft, name: '  ' })));
check('save rejects bad config', throws(() =>
  savePreset({ ...draft, config: { schema: 1, mode: 2, speed: 99, brightness: 0 } })));
check('save keymap preset', (() => {
  const p = savePreset({
    name: 'km test',
    kind: 'keymap',
    description: '',
    target: { protocol: 'khub916' },
    config: { layer: 0, system: false, slots: { 3: 0x10000 } },
  });
  return p.kind === 'keymap' && getPreset(p.id) !== null && deletePreset(p.id);
})());

// Persistence across "reload": writeAll/readAll go through the shim.
{
  const p = savePreset(draft);
  const raw = mem.get(PRESET_STORAGE_KEY);
  check('storage key written', typeof raw === 'string' && raw.includes('"user-'));
  check('storage round-trips config', (() => {
    const parsed = JSON.parse(raw ?? '[]') as { config: { mode: number } }[];
    return parsed[0]?.config.mode === 2;
  })());
  deletePreset(p.id);
}

// ── file import/export ─────────────────────────────────────────────────

section('preset files');

{
  const text = presetFileText(gaming);
  const draft2 = parsePresetFile(text);
  check('file round-trip name', draft2.name === 'Gaming Red');
  check('file round-trip kind', draft2.kind === 'lighting');
  check('file round-trip mode', (draft2.config as { mode: number }).mode === 2);
  check('file carries no builtin flag', !('builtin' in draft2));

  const kmText = presetFileText(km);
  const kmDraft = parsePresetFile(kmText);
  check('keymap file round-trip', kmDraft.kind === 'keymap' &&
    ((kmDraft.config as { slots: Record<number, number> }).slots[92] === 74));

  check('file name slug', presetFileName(gaming) === 'omg-preset-lighting-gaming-red.json', presetFileName(gaming));
  check('rejects non-json', throws(() => parsePresetFile('not json')));
  check('rejects bare scene config', throws(() => parsePresetFile(sceneConfigToJson(gaming.config as never))));
  check('rejects wrong marker', throws(() => parsePresetFile(JSON.stringify({ omg_preset: 2, preset: {} }))));
  check('rejects bad kind', throws(() => parsePresetFile(JSON.stringify({ omg_preset: 1, preset: { name: 'x', kind: 'macro', config: {} } }))));

  // Import → save produces a user preset.
  const imported = savePreset(parsePresetFile(text));
  check('import saves as user preset', imported.builtin === false && imported.id.startsWith('user-'));
  check('imported preset listed', listPresets('lighting').some((p) => p.id === imported.id));
  deletePreset(imported.id);
}

// ── compatibility ──────────────────────────────────────────────────────

section('compatibility');

const k1pro = { vendorId: 0x258a, productId: 0x010c }; // wired K1 Pro
const heKeyboard = { vendorId: 0x1ca6, productId: 11272, usagePage: 0xffb0 };
const unknown = { vendorId: 0x1234, productId: 0x5678 };

check('lighting preset ok on K1 Pro', presetCompatibility(gaming, k1pro).ok);
check('per-key preset ok on K1 Pro', presetCompatibility(
  BUILTIN_PRESETS.find((p) => p.id === 'builtin-light-wasd-highlight')!, k1pro).ok);
check('keymap preset ok on K1 Pro model', presetCompatibility(km, {
  ...k1pro,
  catalogModel: K1_PRO_LAYOUT_MODELS[0]!,
}).ok);
check('keymap preset fails on HE keyboard', !presetCompatibility(km, heKeyboard).ok);
check('lighting preset fails on HE keyboard', !presetCompatibility(gaming, heKeyboard).ok);
check('unknown device → not ok (protocol mismatch)', !presetCompatibility(gaming, unknown).ok);

// A preset with no protocol target should be device-agnostic.
{
  const agnostic: Preset = {
    ...gaming,
    id: 'test-agnostic',
    target: {},
  };
  check('empty target passes anywhere', presetCompatibility(agnostic, unknown).ok);
}

// ── done ───────────────────────────────────────────────────────────────

console.log(failures === 0 ? '\nAll preset smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
