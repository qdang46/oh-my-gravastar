/**
 * NL intent parser — bead `oh-my-gravastar-7js` PART 1.
 *
 * `parseIntent(text, context?)` turns a natural-language request
 * (Vietnamese + English) into a list of `OpInput`s — pre-resolution op
 * drafts the planner (`planner.ts`) lowers to schema-v1 `AgentOp`s once
 * key names meet the device layout and slot indices.
 *
 * Design rules (docs/AGENT-ARCHITECTURE.md §4, docs/SAFETY-SPEC.md):
 *
 * - **Rule-based only.** No LLM calls, no network, no DOM — the module
 *   is safe under Node's type stripping (`scripts/test-intent.ts`).
 * - **Never invent ops.** Unknown phrasing lands in `questions[]`, not
 *   in a guessed op. Ambiguous slot-filling ("which layer?", "which
 *   snapshot?") is a question, not a default.
 * - **Capability-gated.** When `context.capabilities` is present, asks
 *   the device cannot do ("rapid trigger" on a mechanical khub916) land
 *   in `unsupported[]` with the registry reason — never as ops.
 * - **L4 stays unplannable.** "factory reset"-style asks are reported
 *   unsupported, never turned into ops.
 *
 * `OpInput` deliberately keeps key references as NAMES (`keys:
 * {caps_lock: 'left_ctrl'}`) rather than slot indices: slot indices are
 * layout-dependent and `planner.ts`/`resolveKeyRef` already own that
 * resolution. Where the schema allows string refs (`set_adv`), names
 * pass through unchanged.
 */

import type { CapabilityKey, CapabilityMap } from '../core/capabilities.ts';
import { isFeatureAvailable } from '../core/feature-registry.ts';
import { KEY_POOL } from '../keypool.ts';
import { CUSTOM_LIGHT_SLOTS, LIGHT_MODES } from '../proto/light.ts';
import { keyIndexOf, type KeyBlock } from '../k1pro-layout.ts';
import type { SnapshotMeta } from '../safety/snapshots.ts';

// ── Public types ───────────────────────────────────────────────────────

/**
 * What the parser needs from the device side. Structurally satisfied by
 * `DeviceContext` (device-context.ts) — pass it directly; every field is
 * optional so unit tests can inject just capabilities or just a layout.
 */
export interface IntentContext {
  /** Device selector echoed into every emitted op ("auto" default). */
  deviceSelector?: string;
  /** Capability map — gates unsupported asks (SAFETY-SPEC §2). */
  capabilities?: CapabilityMap;
  /** Physical layout — resolves key names to slot/light indices. */
  layout?: readonly KeyBlock[];
  /** Known keymap layers (arg = layer | system<<2), for layer questions. */
  keymaps?: readonly { arg: number }[];
  /** Available snapshots, for restore_snapshot id resolution. */
  snapshots?: readonly Pick<SnapshotMeta, 'id' | 'label' | 'ts'>[];
  /** Existing macro names — for "delete macro X"/bind disambiguation. */
  macros?: readonly { name: string }[];
}

/**
 * A pre-resolution op draft. Field names mirror action-schema.ts; the
 * planner lowers `keys` name→{index,value} and `id`/`latest` resolution
 * before `validateOp` sees them.
 */
export type OpInput =
  | {
      op: 'set_keymap';
      device_selector: string;
      /** Keymap layer 0–3. */
      layer: number;
      system?: number;
      /** source key name → target key name (canonical vocabulary). */
      keys: Record<string, string>;
    }
  | {
      op: 'set_light';
      device_selector: string;
      /** `kb916 light apply` config shape (docs/lighting-schema.md). */
      config: Record<string, unknown>;
    }
  | {
      op: 'set_macro';
      device_selector: string;
      name?: string;
      /** docs/macro-schema.md step array, or {name?, steps}. */
      steps?: unknown;
      bind_key?: string | number;
      delete?: boolean;
    }
  | {
      op: 'set_adv';
      device_selector: string;
      mode: 'mt' | 'socd' | 'tgl';
      key?: string | number;
      key_a?: string | number;
      key_b?: string | number;
      toggle?: string | number;
      tap?: string | number;
      hold?: string | number;
      hold_ms?: number;
      direction?: number;
    }
  | {
      op: 'restore_snapshot';
      device_selector: string;
      /** Resolved snapshot id, when unambiguous. */
      id?: string;
      /** True when the user asked for the latest/most recent snapshot. */
      latest?: boolean;
      sections?: string[];
    }
  | {
      op: 'set_profile_section';
      device_selector: string;
      section: string;
      value: number;
    };

export interface IntentResult {
  /** Op drafts, in request order. Empty when everything was a question. */
  ops: OpInput[];
  /** Human-readable interpretations of what was understood. */
  understood: string[];
  /** Clarifications needed before an op can be built — never guesses. */
  questions: string[];
  /** Asks the device/op-schema cannot satisfy, with reasons. */
  unsupported: string[];
}

// ── Text normalisation ─────────────────────────────────────────────────

/**
 * Lowercase + strip Vietnamese diacritics so one pattern set covers both
 * languages: "đèn chỉ sáng" → "den chi sang", "khôi phục" → "khoi phuc".
 * `đ` is not a combining mark — map it explicitly before NFD.
 */
export function foldIntent(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Key vocabulary ─────────────────────────────────────────────────────

/**
 * Canonical key names the parser emits. `layout` lists the vendor
 * `KeyBlock.name` spellings tried (in order) when resolving a physical
 * slot via `context.layout`; `pool` is the vendor keypool entry whose
 * u32 value the planner writes as the target.
 */
interface KeySpec {
  layout: string[];
  pool?: string;
}

const KEY_SPEC: Record<string, KeySpec> = {
  esc: { layout: ['ESC'], pool: 'ESC' },
  tab: { layout: ['Tab'], pool: 'Tab' },
  caps_lock: { layout: ['Caps', 'CapsLock'], pool: 'Caps' },
  backspace: { layout: ['Back', 'Backspace'], pool: 'Back' },
  enter: { layout: ['Enter', 'Return'], pool: 'Enter' },
  space: { layout: ['Space'], pool: 'Space' },
  delete: { layout: ['Del', 'Delete'], pool: 'Del' },
  insert: { layout: ['Ins', 'Insert'], pool: 'Ins' },
  home: { layout: ['Home'], pool: 'Home' },
  end: { layout: ['End'], pool: 'End' },
  page_up: { layout: ['PgUp', 'PageUp'], pool: 'PgUp' },
  page_down: { layout: ['PgDown', 'PgDn', 'PageDown'], pool: 'PgDn' },
  print_screen: { layout: ['Print', 'PrintScreen'], pool: 'Print' },
  scroll_lock: { layout: ['Scroll', 'ScrollLock'], pool: 'Scroll' },
  left_ctrl: { layout: ['L_Ctrl', 'ControlLeft'], pool: 'L_Ctrl' },
  right_ctrl: { layout: ['R_Ctrl', 'ControlRight'], pool: 'R_Ctrl' },
  left_shift: { layout: ['L_shift', 'ShiftLeft', 'LShift'], pool: 'L_shift' },
  right_shift: { layout: ['R_shift', 'ShiftRight', 'RShift'], pool: 'R_shift' },
  left_alt: { layout: ['L_Alt', 'AltLeft'], pool: 'L_Alt' },
  right_alt: { layout: ['R_Alt', 'AltRight'], pool: 'R_Alt' },
  left_win: { layout: ['L_WIN', 'MetaLeft', 'LWin'], pool: 'L_WIN' },
  right_win: { layout: ['R_WIN', 'MetaRight', 'RWin'], pool: 'R_WIN' },
  fn: { layout: ['Fn'], pool: 'Fn' },
  arrow_up: { layout: ['Up', 'ArrowUp'], pool: 'Up' },
  arrow_down: { layout: ['Down', 'ArrowDown'], pool: 'Down' },
  arrow_left: { layout: ['left', 'Left', 'ArrowLeft'], pool: 'left' },
  arrow_right: { layout: ['right', 'Right', 'ArrowRight'], pool: 'right' },
  volume_up: { layout: ['volume-up'], pool: 'volume-up' },
  volume_down: { layout: ['volume-down'], pool: 'volume-down' },
  mute: { layout: ['mute'], pool: 'mute' },
  play_pause: { layout: ['play-pause'], pool: 'play-pause' },
  previous_song: { layout: ['previous-song'], pool: 'previous-song' },
  next_song: { layout: ['next-song'], pool: 'next-song' },
  calculator: { layout: ['calculator'], pool: 'calculator' },
  browser: { layout: ['browser'], pool: 'browser' },
  my_computer: { layout: ['my-computer'], pool: 'my-computer' },
  task_manager: { layout: ['task-manager'], pool: 'task-manager' },
  mouse_left: { layout: [], pool: 'mouse-left' },
  mouse_right: { layout: [], pool: 'mouse-right' },
  mouse_middle: { layout: [], pool: 'mouse-middle' },
};

for (let i = 1; i <= 12; i++) {
  KEY_SPEC[`f${i}`] = { layout: [`F${i}`], pool: `F${i}` };
}
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  KEY_SPEC[ch] = { layout: [ch.toUpperCase()], pool: ch.toUpperCase() };
}
for (const d of '0123456789') {
  KEY_SPEC[d] = { layout: [d], pool: d };
}

/** alias (already folded) → canonical key name. */
const KEY_ALIAS: Record<string, string> = {
  // modifiers — Vietnamese + English spellings
  ctrl: 'left_ctrl',
  control: 'left_ctrl',
  lctrl: 'left_ctrl',
  leftctrl: 'left_ctrl',
  left_control: 'left_ctrl',
  'ctrl trai': 'left_ctrl',
  'left ctrl': 'left_ctrl',
  'left control': 'left_ctrl',
  rctrl: 'right_ctrl',
  rightctrl: 'right_ctrl',
  right_control: 'right_ctrl',
  'right ctrl': 'right_ctrl',
  shift: 'left_shift',
  'left shift': 'left_shift',
  lshift: 'left_shift',
  leftshift: 'left_shift',
  rshift: 'right_shift',
  rightshift: 'right_shift',
  'right shift': 'right_shift',
  alt: 'left_alt',
  'left alt': 'left_alt',
  lalt: 'left_alt',
  leftalt: 'left_alt',
  option: 'left_alt',
  ralt: 'right_alt',
  rightalt: 'right_alt',
  'right alt': 'right_alt',
  win: 'left_win',
  'left win': 'left_win',
  windows: 'left_win',
  meta: 'left_win',
  lwin: 'left_win',
  rwin: 'right_win',
  'right win': 'right_win',
  super: 'left_win',
  // named keys
  'caps lock': 'caps_lock',
  capslock: 'caps_lock',
  caps: 'caps_lock',
  'phim caps': 'caps_lock',
  esc: 'esc',
  escape: 'esc',
  tab: 'tab',
  'back space': 'backspace',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  home: 'home',
  end: 'end',
  'page up': 'page_up',
  pageup: 'page_up',
  pgup: 'page_up',
  'page down': 'page_down',
  pagedown: 'page_down',
  pgdn: 'page_down',
  'print screen': 'print_screen',
  printscreen: 'print_screen',
  print: 'print_screen',
  'scroll lock': 'scroll_lock',
  scrolllock: 'scroll_lock',
  scroll: 'scroll_lock',
  space: 'space',
  'space bar': 'space',
  spacebar: 'space',
  enter: 'enter',
  return: 'enter',
  'xuong dong': 'enter',
  up: 'arrow_up',
  down: 'arrow_down',
  left: 'arrow_left',
  right: 'arrow_right',
  'mui ten len': 'arrow_up',
  'mui ten xuong': 'arrow_down',
  'mui ten trai': 'arrow_left',
  'mui ten phai': 'arrow_right',
  'arrow up': 'arrow_up',
  'arrow down': 'arrow_down',
  'arrow left': 'arrow_left',
  'arrow right': 'arrow_right',
  fn: 'fn',
  'fn key': 'fn',
  'phim fn': 'fn',
  volup: 'volume_up',
  'volume up': 'volume_up',
  voldown: 'volume_down',
  'volume down': 'volume_down',
  mute: 'mute',
  'play pause': 'play_pause',
  prev: 'previous_song',
  'previous song': 'previous_song',
  next: 'next_song',
  'next song': 'next_song',
  calc: 'calculator',
  'my computer': 'my_computer',
  'task manager': 'task_manager',
  // mouse buttons as targets
  'mouse left': 'mouse_left',
  'left click': 'mouse_left',
  'mouse right': 'mouse_right',
  'right click': 'mouse_right',
  'mouse middle': 'mouse_middle',
  'middle click': 'mouse_middle',
  'chuot trai': 'mouse_left',
  'chuột trái': 'mouse_left',
  'click trai': 'mouse_left',
  'chuot phai': 'mouse_right',
  'chuột phải': 'mouse_right',
  'click phai': 'mouse_right',
  'chuot giua': 'mouse_middle',
  'chuột giữa': 'mouse_middle',
};

/** Resolve a folded token/phrase to a canonical key name, or null. */
export function canonicalKey(name: string): string | null {
  const n = foldIntent(name);
  if (KEY_ALIAS[n]) return KEY_ALIAS[n];
  if (KEY_SPEC[n]) return n;
  const m = /^f(\d{1,2})$/.exec(n);
  if (m) {
    const i = Number(m[1]);
    if (i >= 1 && i <= 12) return `f${i}`;
  }
  return null;
}

// ── Layout helpers ─────────────────────────────────────────────────────

function layoutIndexOf(layout: readonly KeyBlock[], canon: string): number | null {
  const names = KEY_SPEC[canon]?.layout ?? [];
  for (const want of names) {
    const w = want.toLowerCase();
    for (const b of layout) {
      if (b.display && b.name.toLowerCase() === w) return keyIndexOf(b.pos);
    }
  }
  return null;
}

/** Light-table slot (0–125) for a canonical key, via `light_pos`. */
function lightSlotOf(layout: readonly KeyBlock[], canon: string): number | null {
  const names = KEY_SPEC[canon]?.layout ?? [];
  for (const want of names) {
    const w = want.toLowerCase();
    for (const b of layout) {
      if (b.display && b.name.toLowerCase() === w) {
        const slot = b.light_pos - 8;
        return slot >= 0 && slot < CUSTOM_LIGHT_SLOTS ? slot : null;
      }
    }
  }
  return null;
}

// ── Key-phrase extraction ──────────────────────────────────────────────

/**
 * Pull canonical key names out of free text. Multi-word aliases are
 * matched first ("caps lock", "page up"), then single tokens. Returns
 * deduped canonical names; matched spans are blanked out of `rest`.
 */
export function extractKeys(text: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  // Gaming clusters are single tokens — expand before tokenising.
  let rest = ` ${foldIntent(text)} `
    .replace(/\bwasd\b/g, ' w a s d ')
    .replace(/\bhjkl\b/g, ' h j k l ');
  const phrases = Object.keys(KEY_ALIAS)
    .filter((a) => a.includes(' '))
    .sort((a, b) => b.length - a.length);
  for (const p of phrases) {
    const canon = KEY_ALIAS[p]!;
    const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    rest = rest.replace(re, (m) => {
      keys.push(canon);
      return ' '.repeat(m.length);
    });
  }
  const singles =
    /\b([a-z]|\d|f(?:[1-9]|1[0-2])|fn|esc|tab|caps|capslock|enter|return|space|delete|del|insert|ins|home|end|up|down|left|right|ctrl|control|shift|alt|win|meta|option|super|mute|print|scroll|volup|voldown|prev|next|calc)\b/g;
  rest = rest.replace(singles, (m) => {
    const canon = canonicalKey(m);
    if (canon) keys.push(canon);
    return ' '.repeat(m.length);
  });
  return { keys: [...new Set(keys)], rest: rest.replace(/\s+/g, ' ').trim() };
}

// ── Capability gating ──────────────────────────────────────────────────

const FEATURE_TO_CAP: Record<string, CapabilityKey> = {
  'keymap-editor': 'keymap',
  'layer-manager': 'layers',
  'macro-studio': 'macro',
  'per-key-rgb': 'per_key_rgb',
  'lighting-studio': 'lighting_effects',
  'adv-keys': 'adv_keys',
};

/**
 * Gate an intended feature against `context.capabilities`. Missing
 * context = no gate (the planner/validator re-checks later anyway).
 * `unverified` stays plannable but is noted in `understood`.
 */
function gateFeature(
  ctx: IntentContext | undefined,
  res: IntentResult,
  featureId: string,
  what: string,
): boolean {
  const caps = ctx?.capabilities;
  if (!caps) return true;
  if (!isFeatureAvailable(caps, featureId)) {
    const cap = caps[FEATURE_TO_CAP[featureId] ?? 'keymap'];
    const reason = cap?.reason ?? 'not supported by this device';
    const state = cap?.state ?? 'protocol-unknown';
    res.unsupported.push(`${what}: ${state} — ${reason}`);
    return false;
  }
  const cap = caps[FEATURE_TO_CAP[featureId] ?? 'keymap'];
  if (cap?.state === 'unverified' && cap.reason) {
    res.understood.push(`${what}: available but unverified — ${cap.reason}`);
  }
  return true;
}

// ── Colour words ───────────────────────────────────────────────────────

const COLOR_WORDS: Record<string, string> = {
  'mau do': '#FF0000',
  red: '#FF0000',
  do: '#FF0000',
  'xanh la': '#00FF00',
  green: '#00FF00',
  'xanh duong': '#0000FF',
  'xanh lam': '#0000FF',
  blue: '#0000FF',
  'xanh ngoc': '#00FFFF',
  cyan: '#00FFFF',
  'hong nhat': '#FFB6C1',
  magenta: '#FF00FF',
  'hong': '#FF00FF',
  pink: '#FFC0CB',
  white: '#FFFFFF',
  trang: '#FFFFFF',
  yellow: '#FFFF00',
  vang: '#FFFF00',
  orange: '#FFA500',
  cam: '#FFA500',
  'tim': '#800080',
  purple: '#800080',
  violet: '#EE82EE',
  teal: '#008080',
  lime: '#00FF00',
  gold: '#FFD700',
  black: '#000000',
};

const LIGHT_MODE_ALIASES: Record<string, number> = {
  off: 0,
  always_on: 1,
  static: 1,
  'mau tinh': 1,
  breathing: 2,
  'tho': 2,
  'nhap nhay': 2,
  dream_rainbow: 3,
  rainbow: 3,
  'cau vong': 3,
  one_touch: 4,
  'mot cham': 4,
  rain_walk: 5,
  'di mua': 5,
  color_wheel: 6,
  'vong mau': 6,
  key_ripple: 7,
  ripple: 7,
  'goi song': 7,
  stars: 8,
  'ngoi sao': 8,
  snow_trace: 9,
  'vet tuyet': 9,
  flowing: 10,
  'chay': 10,
  wave: 11,
  'song': 11,
  shadow: 12,
  'bong': 12,
  sine_wave: 13,
  windmill: 15,
  'cay bang': 15,
  waterfall: 16,
  'thac nuoc': 16,
  blooming: 17,
  'no hoa': 17,
  custom: 277,
  'tuy chinh': 277,
};

function findColor(folded: string): string | null {
  const names = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(folded)) return COLOR_WORDS[name]!;
  }
  return null;
}

// ── Intent matchers ────────────────────────────────────────────────────

interface MatcherCtx {
  res: IntentResult;
  context: IntentContext | undefined;
  selector: string;
  folded: string;
}

type Matcher = (c: MatcherCtx) => void;

const LIGHT_RE = /\b(den|lights?|lighting|rgb|neon|hieu ung|effects?)\b/;

function tryLighting(c: MatcherCtx): void {
  const { folded, res, context, selector } = c;
  if (!LIGHT_RE.test(folded)) return;
  if (!gateFeature(context, res, 'lighting-studio', 'lighting change')) return;

  const config: Record<string, unknown> = {};

  // Per-key subset: "đèn chỉ sáng WASD" / "only WASD lit" / "sáng WASD thôi".
  let litKeys: string[] | null = null;
  const subsetPats = [
    /(?:chi|only|just)\s+(?:sang|lit|on|sang cho|cho)\s+(.+)$/,
    /(?:chi|only|just)\s+(.+?)\s+(?:sang|lit|on)\s*$/,
    /(?:sang|lit|on)\s+(.+?)\s+(?:thoi|only|alone)\b/,
  ];
  for (const re of subsetPats) {
    const m = re.exec(folded);
    if (!m?.[1]) continue;
    const { keys } = extractKeys(m[1]);
    if (keys.length > 0) {
      litKeys = keys;
      break;
    }
  }
  // Fallback: "đèn chỉ sáng <tail>" where the tail held the keys.
  if (!litKeys && /\bchi\b/.test(folded) && /\b(sang|lit|on)\b/.test(folded)) {
    const tail = folded.split(/\b(?:sang|lit|on)\b/).pop() ?? '';
    const { keys } = extractKeys(tail);
    if (keys.length > 0) litKeys = keys;
  }

  if (litKeys) {
    const layout = context?.layout;
    if (!layout) {
      res.questions.push(
        `Per-key lighting needs the device layout to know which slots "${litKeys.join(', ')}" occupy — connect the device or pass a layout.`,
      );
      return;
    }
    const colors = new Array<string>(CUSTOM_LIGHT_SLOTS).fill('#000000');
    const litColor = findColor(folded) ?? '#FFFFFF';
    const missing: string[] = [];
    for (const k of litKeys) {
      const slot = lightSlotOf(layout, k);
      if (slot === null) missing.push(k);
      else colors[slot] = litColor;
    }
    if (missing.length > 0) {
      res.questions.push(`Could not find key(s) ${missing.join(', ')} on the device layout.`);
      if (colors.every((col) => col === '#000000')) return;
    }
    config.mode = 277; // vendor 'custom' per-key mode
    config.keys = { colors };
    res.ops.push({ op: 'set_light', device_selector: selector, config });
    res.understood.push(
      `Lighting: only ${litKeys.join('/')} lit in ${litColor} (per-key custom mode, other keys off).`,
    );
    return;
  }

  // Off.
  if (/\b(tat|off|disable|ngung)\b/.test(folded)) {
    config.mode = 0;
    res.ops.push({ op: 'set_light', device_selector: selector, config });
    res.understood.push('Lighting: off (mode 0).');
    return;
  }

  // Explicit mode name (longest alias first).
  const modeEntries = Object.entries(LIGHT_MODE_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, id] of modeEntries) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(folded)) {
      config.mode = id;
      res.understood.push(
        `Lighting mode → ${LIGHT_MODES.find((m) => m.id === id)?.name ?? id}.`,
      );
      break;
    }
  }

  // Colour word or #rrggbb.
  const hex = /#([0-9a-f]{6})\b/.exec(folded);
  const color = hex ? `#${hex[1]!.toUpperCase()}` : findColor(folded);
  if (color) {
    config.color = color;
    if (config.mode === undefined) config.mode = 1; // always_on for a plain colour ask
    res.understood.push(`Lighting colour → ${color}.`);
  }

  // Brightness: "sáng 80%", "dim", "sáng hết".
  const pct = /(\d{1,3})\s*%/.exec(folded);
  if (pct) {
    const p = Math.min(100, Math.max(0, Number(pct[1])));
    config.brightness = Math.round((p / 100) * 20);
    res.understood.push(`Brightness → ${p}% (vendor scale ${config.brightness}/20).`);
  } else if (/\b(sang het|max|full)\b/.test(folded) && /\bsang\b|bright/.test(folded)) {
    config.brightness = 20;
  } else if (/\b(dim|toi|mo|giam|dimmer|lower)\b/.test(folded)) {
    config.brightness = 5;
    res.understood.push('Brightness → dim (5/20).');
  }

  // Speed: "nhanh", "chậm", "speed N".
  const speedN = /(?:speed|toc do|toc)\s*(\d{1,2})\b/.exec(folded);
  if (speedN) {
    config.speed = Math.min(20, Math.max(0, Number(speedN[1])));
  } else if (/\b(nhanh|fast)\b/.test(folded)) {
    config.speed = 20;
  } else if (/\b(cham|slow)\b/.test(folded)) {
    config.speed = 3;
  }

  if (Object.keys(config).length === 0) {
    res.questions.push(
      'Lighting request is too vague — try a colour ("đèn đỏ"), an effect ("breathing"), brightness ("sáng 80%") or "đèn tắt".',
    );
    return;
  }
  res.ops.push({ op: 'set_light', device_selector: selector, config });
}

function tryRestore(c: MatcherCtx): void {
  const { folded, res, context, selector } = c;

  // L4 guard FIRST: factory reset / wipe / "về mặc định" phrasing is
  // never an op — report it even when no restore keyword is present.
  if (
    /\b(factory|wipe|xoa sach)\b/.test(folded) ||
    (/\bmac dinh\b/.test(folded) && /\b(reset|khoi phuc|restore|quay|ve)\b/.test(folded))
  ) {
    if (/\b(reset|khoi phuc|restore|xoa|wipe|factory|ve)\b/.test(folded)) {
      res.unsupported.push(
        'factory reset / wipe is a forbidden (L4) operation — use restore_snapshot of a backup instead',
      );
      return;
    }
  }

  const wantsRestore =
    /\b(khoi phuc|restore|quay lai|undo|hoan tac|revert|rollback|snapshot|ban sao|restore point|diem khoi phuc)\b/.test(
      folded,
    );
  if (!wantsRestore) return;

  const snaps = context?.snapshots ?? [];

  // Score snapshots by how many label words appear in the request.
  const scored = snaps
    .map((s) => {
      const words = `${s.id} ${s.label}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
      const score = words.filter((w) => folded.includes(w)).length;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let matched: { id: string; label: string } | null = null;
  if (scored.length === 1) {
    matched = { id: scored[0]!.s.id, label: scored[0]!.s.label };
  } else if (scored.length > 1 && scored[0]!.score > scored[1]!.score) {
    matched = { id: scored[0]!.s.id, label: scored[0]!.s.label };
  }

  // "mới nhất" / "latest" / "last" → newest snapshot by timestamp.
  if (/\b(moi nhat|latest|last|gan nhat)\b/.test(folded) && snaps.length > 0) {
    const latest = [...snaps].sort((a, b) => b.ts.localeCompare(a.ts))[0]!;
    matched = { id: latest.id, label: latest.label };
  }

  if (!matched && snaps.length === 0) {
    res.ops.push({ op: 'restore_snapshot', device_selector: selector, latest: true });
    res.questions.push('No snapshots are known — which restore point should be used?');
    res.understood.push('Restore snapshot requested (latest).');
    return;
  }
  if (!matched) {
    const top = scored.slice(0, 4).map((x) => x.s.label);
    res.questions.push(
      `Which snapshot?${top.length ? ` Candidates: ${top.join(', ')}.` : ` Known: ${snaps.map((s) => s.label).join(', ')}.`}`,
    );
    return;
  }
  res.ops.push({ op: 'restore_snapshot', device_selector: selector, id: matched.id });
  res.understood.push(`Restore snapshot "${matched.label}".`);
}

const WASD_ARROW: Record<string, string> = {
  w: 'arrow_up',
  a: 'arrow_left',
  s: 'arrow_down',
  d: 'arrow_right',
};

/** Phrases that scope a remap to a layer/Fn hold — stripped before key extraction. */
const LAYER_QUALIFIER_RE =
  /\b(khi giu fn|khi nhan fn|while holding fn|when holding fn|hold fn|giu fn|nhan fn|o layer \d|tren layer \d|trên layer \d|layer \d|tang \d|key ?set \d)\b/g;

function layerFromText(folded: string, res: IntentResult): number {
  // "layer 2" / "tầng 2" / "key set 3" — 1..4 reads as key set N → index N-1.
  const m = /\b(?:layer|tang|key ?set|keyset)\s*(\d)\b/.exec(folded);
  if (m) {
    const n = Number(m[1]);
    if (n === 0) return 0;
    if (n >= 1 && n <= 4) {
      res.understood.push(`Layer "${n}" read as key set ${n} → layer index ${n - 1}.`);
      return n - 1;
    }
  }
  // "khi giữ Fn" / "while holding fn" — conditional layer we cannot number.
  if (/\b(khi giu fn|khi nhan fn|while holding fn|when holding fn|giu fn|nhan fn|fn layer)\b/.test(folded)) {
    return -1; // sentinel: needs clarification
  }
  return 0;
}

function tryKeymap(c: MatcherCtx): void {
  const { folded, res, context, selector } = c;
  // Trigger shapes: "X thành Y", "X as Y", "X -> Y", "đổi X thành Y", "map X to Y".
  const conn = /^(.*?)\s+(?:thanh|as|to|->|=>|=)\s+(.+)$/.exec(folded);
  if (!conn) return;
  let srcText = (conn[1] ?? '').trim();
  let dstText = (conn[2] ?? '').trim();
  if (!srcText || !dstText) return;
  // Strip leading intent verbs ("đổi caps thành ctrl", "map caps to ctrl").
  srcText = srcText.replace(/^(?:hay|hoac|and|or|doi|map|put|set|chuyen|cho)\s+/, '');
  // Strip layer qualifiers from BOTH sides before key extraction.
  dstText = dstText.replace(LAYER_QUALIFIER_RE, ' ').replace(/\s+/g, ' ').trim();
  srcText = srcText.replace(LAYER_QUALIFIER_RE, ' ').replace(/\s+/g, ' ').trim();

  const src = extractKeys(srcText);
  const dst = extractKeys(dstText);

  // Nothing key-like on either side → not a remap (e.g. "turn to red").
  if (src.keys.length === 0 && dst.keys.length === 0) return;

  let pairs: [string, string][] = [];
  const wantsArrow = /\barrows?\b|\bmui ten\b/.test(dstText);

  if (dst.keys.length === 0) {
    if (wantsArrow && src.keys.length > 0 && src.keys.every((k) => k in WASD_ARROW)) {
      pairs = src.keys.map((k) => [k, WASD_ARROW[k]!]);
      res.understood.push(
        'Interpreted "arrow" per WASD convention: W→Up, A→Left, S→Down, D→Right.',
      );
    } else if (wantsArrow) {
      res.questions.push(
        '"arrow" alone is ambiguous — which arrow (up/down/left/right), or WASD for all four?',
      );
      return;
    } else {
      res.questions.push(`I could not find a target key in "${dstText}".`);
      return;
    }
  } else if (src.keys.length === 0) {
    res.questions.push(`I could not find a source key in "${srcText}".`);
    return;
  } else if (src.keys.length === dst.keys.length) {
    pairs = src.keys.map((s, i) => [s, dst.keys[i]!]);
  } else if (dst.keys.length === 1) {
    pairs = src.keys.map((s) => [s, dst.keys[0]!]);
  } else {
    res.questions.push(
      `Got ${src.keys.length} source keys but ${dst.keys.length} targets — pair them explicitly (e.g. "W up, A left").`,
    );
    return;
  }

  // Layer resolution.
  const layer = layerFromText(folded, res);
  if (layer === -1) {
    res.understood.push('Recognised a Fn-held conditional remap.');
    res.questions.push(
      '"khi giữ Fn" needs a target layer — which layer should the Fn-held mapping live on (1–4)?',
    );
    return;
  }

  // Capability gate: keymap always; layers for layer > 0.
  if (!gateFeature(context, res, 'keymap-editor', 'keymap change')) return;
  if (layer > 0 && !gateFeature(context, res, 'layer-manager', `keymap on layer ${layer}`)) return;

  // Source keys must exist on the layout when we have one; targets only
  // need a writable pool value (they need not be physical keys).
  const layout = context?.layout;
  const keys: Record<string, string> = {};
  const missing: string[] = [];
  const badTargets: string[] = [];
  for (const [s, d] of pairs) {
    if (layout && layoutIndexOf(layout, s) === null) missing.push(s);
    if (!KEY_SPEC[d]?.pool) badTargets.push(d);
    keys[s] = d;
  }
  if (missing.length > 0) {
    res.questions.push(`Key(s) not on this layout: ${[...new Set(missing)].join(', ')}.`);
    return;
  }
  if (badTargets.length > 0) {
    res.questions.push(`No writable value for target(s): ${[...new Set(badTargets)].join(', ')}.`);
    return;
  }

  res.ops.push({ op: 'set_keymap', device_selector: selector, layer, keys });
  const summary = pairs.map(([s, d]) => `${s}→${d}`).join(', ');
  res.understood.push(
    `Keymap layer ${layer}: ${summary}${layer === 0 ? ' (base key set)' : ''}.`,
  );
}

function tryAdv(c: MatcherCtx): void {
  const { folded, res, context, selector } = c;

  // HE-only / no-op-schema asks → unsupported, never ops. When a
  // capability map is present, append the registry reason.
  const NO_OP: Record<string, { what: string; cap?: CapabilityKey }> = {
    'rapid trigger': { what: 'rapid trigger', cap: 'rapid_trigger' },
    'rapid-trigger': { what: 'rapid trigger', cap: 'rapid_trigger' },
    rt: { what: 'rapid trigger', cap: 'rapid_trigger' },
    actuation: { what: 'actuation point', cap: 'actuation' },
    'diem ban': { what: 'actuation point', cap: 'actuation' },
    deadzone: { what: 'deadzone', cap: 'deadzone' },
    'vung chet': { what: 'deadzone', cap: 'deadzone' },
    dks: { what: 'DKS/MPT', cap: 'dks_mpt' },
    mpt: { what: 'DKS/MPT', cap: 'dks_mpt' },
    calibration: { what: 'calibration', cap: 'calibration' },
    'hieu chinh': { what: 'calibration', cap: 'calibration' },
    polling: { what: 'polling rate', cap: 'polling' },
    'tan so': { what: 'polling rate', cap: 'polling' },
    'live travel': { what: 'live travel', cap: 'live_travel' },
    travel: { what: 'live travel', cap: 'live_travel' },
    'hanh trinh': { what: 'live travel', cap: 'live_travel' },
  };
  for (const [word, info] of Object.entries(NO_OP)) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(folded)) {
      const cap = info.cap ? context?.capabilities?.[info.cap] : undefined;
      const reason = cap?.reason ? ` — ${cap.reason}` : '';
      res.unsupported.push(
        `${info.what}: recognised but not plannable — no ${info.what} op exists in agent schema v1 (HE-v2 performance ops are a later milestone)${reason}`,
      );
      return;
    }
  }

  const wantsAdv = /\b(socd|simultaneous|cung luc|mod.?tap|\bmt\b|tgl|toggle|adv)\b/.test(folded);
  if (!wantsAdv) return;

  // Capability gate on adv_keys directly (the feature registry entry is
  // 'adv-keys'; khub916 reports 'unverified' — plannable with a caveat).
  const caps = context?.capabilities;
  const advCap = caps?.adv_keys;
  if (caps) {
    if (!advCap || !['supported', 'experimental', 'unverified'].includes(advCap.state)) {
      res.unsupported.push(
        `advanced keys (SOCD/MT/TGL): ${advCap?.state ?? 'protocol-unknown'} — ${advCap?.reason ?? 'not supported by this device'}`,
      );
      return;
    }
    if (advCap.state === 'unverified' && advCap.reason) {
      res.understood.push(`Advanced keys: available but unverified — ${advCap.reason}`);
    }
  }

  // SOCD: "socd a d" / "a và d socd" / "simultaneous a d".
  if (/\b(socd|simultaneous|cung luc|hai phim cung)\b/.test(folded)) {
    const keys = extractKeys(
      folded.replace(/\b(socd|simultaneous|cung luc|hai phim cung)\b/g, ' '),
    ).keys;
    if (keys.length < 2) {
      res.questions.push('SOCD needs two keys (e.g. "SOCD A D").');
      return;
    }
    res.ops.push({
      op: 'set_adv',
      device_selector: selector,
      mode: 'socd',
      key_a: keys[0],
      key_b: keys[1],
    });
    res.understood.push(`SOCD on ${keys[0]}/${keys[1]} (direction default 0).`);
    return;
  }

  // MT (mod-tap): "caps mod-tap tap esc hold ctrl 200ms".
  if (/\b(mod.?tap|\bmt\b|giữ.?chạm|giu.?cham)\b/.test(folded)) {
    const { keys } = extractKeys(folded);
    const bind = keys[0];
    if (!bind) {
      res.questions.push('Mod-tap needs a bind key (e.g. "CAPS mod-tap tap ESC hold CTRL").');
      return;
    }
    const tapM = /\btap\s+([a-z0-9 ]+?)(?=\s+hold\b|\s*$)/.exec(folded);
    const holdM = /\bhold\s+([a-z0-9 ]+?)(?=\s+\d+\s*ms\b|\s|$)/.exec(folded);
    const holdMs = /(\d+)\s*ms\b/.exec(folded);
    const op: Extract<OpInput, { op: 'set_adv' }> = {
      op: 'set_adv',
      device_selector: selector,
      mode: 'mt',
      key: bind,
    };
    if (tapM?.[1]) {
      const t = extractKeys(tapM[1]).keys[0];
      if (t) op.tap = t;
    }
    if (holdM?.[1]) {
      const h = extractKeys(holdM[1]).keys[0];
      if (h) op.hold = h;
    }
    if (holdMs) op.hold_ms = Number(holdMs[1]);
    if (op.tap === undefined || op.hold === undefined) {
      res.questions.push(
        'Mod-tap needs both a tap and a hold target (e.g. "CAPS mod-tap tap ESC hold CTRL 200ms").',
      );
      return;
    }
    res.ops.push(op);
    res.understood.push(`MT on ${bind}: tap=${String(op.tap)} hold=${String(op.hold)}.`);
    return;
  }

  // TGL: "tgl a b" / "a toggle b".
  if (/\b(tgl|toggle)\b/.test(folded)) {
    const keys = extractKeys(folded.replace(/\b(tgl|toggle)\b/g, ' ')).keys;
    if (keys.length < 2) {
      res.questions.push('Toggle needs a bind key and a toggle key (e.g. "TGL A B").');
      return;
    }
    res.ops.push({
      op: 'set_adv',
      device_selector: selector,
      mode: 'tgl',
      key: keys[0],
      toggle: keys[1],
    });
    res.understood.push(`TGL on ${keys[0]} → ${keys[1]}.`);
  }
}

/** Vendor macro-key name for typed text (docs/macro-schema.md grammar). */
function macroKeyForChar(ch: string): string | null {
  if (/^[a-z]$/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  const named: Record<string, string> = {
    ' ': 'Space',
    '\n': 'Enter',
    '.': 'Period',
    ',': 'Comma',
    '-': 'Minus',
    '=': 'Equal',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    '\\': 'Backslash',
    '/': 'Slash',
  };
  return named[ch] ?? null;
}

function tryMacro(c: MatcherCtx): void {
  const { folded, res, context, selector } = c;
  if (!/\bmacro\b/.test(folded)) return;

  const gate = gateFeature(context, res, 'macro-studio', 'macro change');
  if (!gate) return;

  // Delete: "xóa macro X" / "delete macro X" / "remove macro X".
  if (/\b(xoa|delete|remove|bo)\b/.test(folded)) {
    const nameM = /["']([^"']+)["']/.exec(folded) ?? /\bmacro\s+["']?([\w -]{1,40})["']?/.exec(folded);
    const asked = nameM?.[1]?.trim();
    const known = context?.macros?.map((m) => m.name) ?? [];
    const match = asked ? known.find((n) => foldIntent(n).includes(foldIntent(asked))) : undefined;
    if (known.length > 0 && asked && !match) {
      res.questions.push(`Which macro? Known: ${known.join(', ')}.`);
      return;
    }
    if (known.length > 1 && !asked) {
      res.questions.push(`Which macro? Known: ${known.join(', ')}.`);
      return;
    }
    res.ops.push({
      op: 'set_macro',
      device_selector: selector,
      ...(match ?? (asked && known.length === 0 ? asked : match) ? { name: match ?? asked } : {}),
      delete: true,
    });
    res.understood.push(`Delete macro${match ?? asked ? ` "${match ?? asked}"` : ''}.`);
    return;
  }

  // Name: "macro tên X" / "macro X" / "macro name X".
  let name: string | undefined;
  const nameM =
    /(?:macro|tao macro)\s+(?:la|ten|name|called|:)\s*["']?([\w -]{1,40}?)["']?(?:\s|$)/.exec(folded) ??
    /\bmacro\s+["']?([\w-]{1,40})["']?/.exec(folded);
  if (nameM?.[1]) {
    const cand = nameM[1].trim();
    if (!/^(ghi|type|nhap|record|delete|xoa|chay|play|bind|gan|stop|ten|name)$/.test(cand)) {
      name = cand;
    }
  }

  // Steps: text after "ghi/type/nhap/record", up to a bind clause.
  const seqM =
    /(?:ghi|type|nhap|record|bam)\s+(.+?)(?=\s+(?:gan|bind|gan vao|va|voi|with)\b.*$|$)/.exec(folded);
  const bindM = /(?:gan|bind|gan vao|gan len|on)\s+(?:phim\s+|key\s+)?([a-z0-9 ]+?)(?:\s+(?:va|and|voi|with)\b|$)/.exec(folded);
  let bindKey: string | number | undefined;
  if (bindM?.[1]) {
    const k = extractKeys(bindM[1]).keys[0];
    if (k) bindKey = k;
  }

  let steps: unknown;
  let typedText = '';
  if (seqM?.[1]) {
    typedText = seqM[1].trim();
    const arr: Record<string, unknown>[] = [];
    const bad: string[] = [];
    for (const ch of typedText) {
      const key = macroKeyForChar(ch);
      if (!key) {
        bad.push(ch);
        continue;
      }
      arr.push({ action: 'down', key, delay_ms: 0 });
      arr.push({ action: 'up', key, delay_ms: 30 });
    }
    if (bad.length > 0) {
      res.understood.push(`Skipped untypable character(s): ${[...new Set(bad)].join('')}.`);
    }
    if (arr.length > 0) steps = arr;
  }

  if (!steps && name === undefined) {
    res.questions.push(
      'Macro needs a name and/or keys to press — e.g. "macro ghi hello" or "macro tên chao".',
    );
    return;
  }
  if (!steps) {
    res.questions.push(`Macro "${name}" needs the keys it should press ("macro ${name} ghi …").`);
    return;
  }
  // Derive a name from the typed text when none was given (noted below).
  const finalName = name ?? typedText.slice(0, 40);
  if (!name) res.understood.push(`Macro named after its text: "${finalName}".`);
  res.ops.push({
    op: 'set_macro',
    device_selector: selector,
    name: finalName,
    steps,
    ...(bindKey !== undefined ? { bind_key: bindKey } : {}),
  });
  const presses = Array.isArray(steps) ? steps.length / 2 : 0;
  res.understood.push(
    `Macro "${finalName}": ${presses} key press(es)${bindKey !== undefined ? ` bound to ${bindKey}` : ''}.`,
  );
}

function tryProfile(c: MatcherCtx): void {
  const { folded, res, selector } = c;
  // Sleep timer: "ngủ sau 5 phút" / "sleep 300" / "sleep off" / "ngủ 10p".
  const m =
    /\b(?:sleep|ngu|hen gio|timeout)\b\s*(?:sau|after|in|for|=|:)?\s*(?:(\d+)\s*(phut|ph|minute|min|giay|gi|second|sec|s)\b|(\d+)\b|(off|tat|khong|never|vo han))?/.exec(
      folded,
    );
  if (!m) return;
  let seconds: number | null = null;
  const offWord = m[4];
  if (offWord === 'off' || offWord === 'tat' || offWord === 'never' || offWord === 'khong' || offWord === 'vo han') {
    seconds = 0;
  } else if (m[1] !== undefined) {
    const n = Number(m[1]);
    const unit = m[2] ?? '';
    seconds = /phut|ph$|minute|min/.test(unit) ? n * 60 : n;
  } else if (m[3] !== undefined) {
    seconds = Number(m[3]); // bare number → seconds
  }
  if (seconds === null) {
    res.questions.push('Sleep timer needs a duration (e.g. "ngủ sau 5 phút" or "sleep 300").');
    return;
  }
  if (seconds > 255) {
    res.questions.push(`Sleep seconds must be 0–255 (wire u8); ${seconds}s is too long.`);
    return;
  }
  res.ops.push({
    op: 'set_profile_section',
    device_selector: selector,
    section: 'sleep_seconds',
    value: seconds,
  });
  res.understood.push(`Sleep timeout → ${seconds}s.`);
}

function tryExplain(c: MatcherCtx): void {
  const { folded, res } = c;
  // Read-only asks — only when nothing else produced an op.
  if (res.ops.length > 0 || res.unsupported.length > 0) return;
  if (
    /\b(explain|giai thich|what can|capabilit|help|tro giup|thiet bi|device info|status|pin|battery|suc khoe|diagnos\w*|analysis|phan tich|debug|probe)\b/.test(
      folded,
    )
  ) {
    res.understood.push(
      'Read-only request — no device write needed. Use the "Explain my keyboard" capability dump / device status.',
    );
  }
}

/** "tạo layer X" / "create layer X" — layer scaffolding needs key pairs. */
function tryLayerPreset(c: MatcherCtx): void {
  const { folded, res } = c;
  if (!/\b(tao|create|new|them|add|make)\b[^]*\b(layer|tang|key ?set)\b/.test(folded)) return;
  if (res.ops.length > 0) return;
  res.questions.push(
    'Creating a layer needs the key→target pairs for it (e.g. "layer 2: WASD thành arrow, ESC thành layer 0"). Preset layers (navigation/gaming/coding) are a planner feature, not rule-parsed yet.',
  );
}

const MATCHERS: Matcher[] = [
  tryLighting,
  tryRestore,
  tryKeymap,
  tryAdv,
  tryMacro,
  tryProfile,
  tryLayerPreset,
  tryExplain,
];

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Parse a natural-language request into op drafts.
 *
 * `context` is optional: without it the parser still recognises intents
 * but cannot capability-gate or resolve layout-dependent details — those
 * become `questions[]` rather than guesses.
 */
export function parseIntent(text: string, context?: IntentContext): IntentResult {
  const res: IntentResult = { ops: [], understood: [], questions: [], unsupported: [] };
  const folded = foldIntent(text ?? '');
  if (!folded) {
    res.questions.push('Empty request.');
    return res;
  }
  const c: MatcherCtx = {
    res,
    context,
    selector: context?.deviceSelector ?? 'auto',
    folded,
  };
  for (const m of MATCHERS) m(c);

  if (res.ops.length === 0 && res.unsupported.length === 0 && res.questions.length === 0) {
    res.questions.push(
      `I didn't understand "${(text ?? '').trim()}". Try e.g. "caps lock thành ctrl", "đèn đỏ", "macro ghi hello", "khôi phục snapshot".`,
    );
  }
  return res;
}
