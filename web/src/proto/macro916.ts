/**
 * khub916 macro region codec — TypeScript port of
 * `crates/proto-khub916/src/macro916.rs` (itself a port of the vendor JS
 * `extractPossibleHeaders` / `assembleGroupsWithLog` /
 * `getKeyBoardMacroKeyList` / `setKeyBoardMacroIndependent` paths in
 * `docs/research/khub-webapp/index-M8-m9qFR.deob.js`, class `Ht`).
 * Spec: `docs/protocol-khub916.md` §6 "Macro region"; JSON schema:
 * `docs/macro-schema.md`. **Code-verified only** until exercised on
 * hardware.
 *
 * # Wire layout (≤512 B region)
 *
 * ```text
 * [header table: N × 4 B][bodies, concatenated in order]
 * header i: [offsetLo, offsetHi, lenLo, lenHi]  (both u16 little-endian)
 *   offset = absolute position of body i in the region (≥ 4·N)
 *   len    = body length in bytes
 * body:    [nameLen u8][name UTF-8 (nameLen bytes)][steps × 4 B]
 * step:    [ (kindBase + action·8)<<4 | durHi, durMid, durLo, usage ]
 *   duration = 20-bit value ((byte0 & 0x0F)<<16 | byte1<<8 | byte2)
 *   kindBase: 0 = key, 1 = modifier, 2 = mouse
 *   action:   0 = down/press, 1 = up/release
 *   usage:    HID usage id / mouse button code (vendor `fe` table, u8)
 * ```
 *
 * The first header's `offset` doubles as the header-table length `r`
 * (`r = u16le(region[0..2])`, must be ≥4, ≤ region length, multiple of 4)
 * — the vendor scanner parses exactly `r/4` headers and then reads bodies
 * sequentially from offset `r`. Writes send the region **zero-padded to
 * 512 bytes** in one cmd-5 feature report `[5,0,0,1,0,len&0xFF,0]`.
 */

/** Macro region capacity on the wire (also the keymap payload size). */
export const MACRO_REGION_BYTES = 512;
/** Vendor sanity bound on a single entry body length. */
const MAX_ENTRY_LEN = 10_000;
/** Largest storable step duration: the wire field is 20 bits. */
export const MAX_STEP_DURATION = 0x000f_ffff;

// ── Step / entry model ──────────────────────────────────────────────────

/**
 * Step key class — the low 3 bits of the step's high nibble
 * (`kindBase`). The three known classes are named; any other decoded
 * nibble is kept as its raw 4-bit number so decode→encode round-trips
 * preserve it verbatim (mirrors Rust `StepKind::Other`).
 */
export type StepKind = 'key' | 'modifier' | 'mouse' | number;

/** Nibble base written on encode (key=0, modifier=1, mouse=2). */
function kindBase(kind: StepKind): number | null {
  switch (kind) {
    case 'key':
      return 0;
    case 'modifier':
      return 1;
    case 'mouse':
      return 2;
    default:
      return null; // raw Other nibble
  }
}

/**
 * One macro step: press or release `usage` after `delayMs`.
 * `action`: 0 = down/press, 1 = up/release (the vendor `action` field;
 * the wire nibble is `kindBase + action*8`). `delayMs` is the stored
 * 20-bit duration — the vendor recorder stores the interval *following*
 * each event until the next one (device-side playback semantics are
 * code-verified only, spec §8).
 */
export interface MacroStep {
  /** 0 = down/press, 1 = up/release. */
  action: number;
  /** Stored duration in milliseconds (0..=`MAX_STEP_DURATION`). */
  delayMs: number;
  /** Key code byte (HID usage or mouse button value, vendor `fe` table). */
  usage: number;
  /** Key class selecting the nibble base. */
  kind: StepKind;
}

/** One named macro: UTF-8 name (≤255 bytes) plus its steps. */
export interface MacroEntry {
  name: string;
  steps: MacroStep[];
}

// ── Vendor `fe` key-name table (KeyboardEvent.code → usage value) ────────

/**
 * `(name, usage)` pairs in vendor table order (first match wins on
 * decode, exactly like `fe.find`). Values >255 ("Fn" = 0x0D000000,
 * "counter") cannot appear in a step's u8 usage byte — rejected on
 * import, matching the Rust port.
 */
export const MACRO_KEY_TABLE: readonly (readonly [string, number])[] = [
  ['ESC', 41], ['Backquote', 53], ['Tab', 43], ['CapsLock', 57],
  ['ShiftLeft', 225], ['ControlLeft', 224], ['Digit1', 30], ['KeyQ', 20],
  ['KeyA', 4], ['KeyZ', 29], ['MetaLeft', 227], ['F1', 58],
  ['Digit2', 31], ['KeyW', 26], ['KeyS', 22], ['KeyX', 27],
  ['AltLeft', 226], ['F2', 59], ['Digit3', 32], ['KeyE', 8],
  ['KeyD', 7], ['KeyC', 6], ['F3', 60], ['Digit4', 33],
  ['KeyR', 21], ['KeyF', 9], ['KeyV', 25], ['F4', 61],
  ['Digit5', 34], ['KeyT', 23], ['KeyG', 10], ['KeyB', 5],
  ['Space', 44], ['F5', 62], ['Digit6', 35], ['KeyY', 28],
  ['KeyH', 11], ['KeyN', 17], ['F6', 63], ['Digit7', 36],
  ['KeyU', 24], ['KeyJ', 13], ['KeyM', 16], ['F7', 64],
  ['Digit8', 37], ['KeyI', 12], ['KeyK', 14], ['Comma', 54],
  ['AltRight', 230], ['F8', 65], ['Digit9', 38], ['KeyO', 18],
  ['KeyL', 15], ['Period', 55], ['Fn', 218103808], ['F9', 66],
  ['Digit0', 39], ['KeyP', 19], ['Semicolon', 51], ['Slash', 56],
  ['ContextMenu', 101], ['F10', 67], ['Minus', 45], ['BracketLeft', 47],
  ['Quote', 52], ['F11', 68], ['Equal', 46], ['BracketRight', 48],
  ['Enter', 40], ['ShiftRight', 229], ['ControlRight', 228], ['F12', 69],
  ['Back', 42], ['Backslash', 49], ['Print', 70], ['Insert', 73],
  ['Delete', 76], ['ArrowLeft', 80], ['ScrollLock', 71], ['Home', 74],
  ['End', 77], ['ArrowUp', 82], ['ArrowDown', 81], ['Pause', 72],
  ['PageUp', 75], ['PageDown', 78], ['ArrowRight', 79],
  ['counter', 33554834], ['NumLock', 83], ['Numpad7', 95],
  ['Numpad4', 92], ['Numpad1', 89], ['Numpad0', 98],
  ['NumpadDivide', 84], ['Numpad8', 96], ['Numpad5', 93],
  ['Numpad2', 90], ['NumpadMultiply', 85], ['Numpad9', 97],
  ['Numpad6', 94], ['Numpad3', 91], ['NumpadDecimal', 99],
  ['NumpadSubtract', 86], ['NumpadAdd', 87], ['NumpadEnter', 88],
  ['MouseLeft', 1], ['MouseMiddle', 4], ['MouseRight', 2],
  ['MouseBack', 16], ['MouseForward', 8],
];

/** Names the vendor treats as modifiers for the nibble base. */
export const MODIFIER_KEY_NAMES: readonly string[] = [
  'ShiftLeft', 'ControlLeft', 'MetaLeft', 'AltLeft', 'AltRight',
  'ShiftRight', 'ControlRight',
];

/** Names the vendor treats as mouse buttons (nibble base 2). */
export const MOUSE_KEY_NAMES: readonly string[] = [
  'MouseLeft', 'MouseRight', 'MouseMiddle', 'MouseForward', 'MouseBack',
];

/** Usage value for a vendor key name (`fe.find(name)`); `null` = unknown. */
export function macroUsageForName(name: string): number | null {
  for (const [n, v] of MACRO_KEY_TABLE) {
    if (n === name) return v;
  }
  return null;
}

/**
 * Vendor display name for a usage byte: the mouse special cases
 * (`MouseForward`=8 / `MouseBack`=16 only when the nibble is a mouse
 * action) then first-match `fe.find(value)`; `null` when unnamed.
 */
export function macroNameForUsage(usage: number, kind: StepKind): string | null {
  if (kind === 'mouse') {
    if (usage === 8) return 'MouseForward';
    if (usage === 16) return 'MouseBack';
  }
  for (const [n, v] of MACRO_KEY_TABLE) {
    if (v === usage) return n;
  }
  return null;
}

/** Default `StepKind` for a vendor key name (modifier/mouse lists). */
export function defaultKindForName(name: string): StepKind {
  if (MODIFIER_KEY_NAMES.includes(name)) return 'modifier';
  if (MOUSE_KEY_NAMES.includes(name)) return 'mouse';
  return 'key';
}

// ── Decode (vendor `extractPossibleHeaders` + `getKeyBoardMacroKeyList`) ──

function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

/**
 * Decode one 4-byte step `[b0, b1, b2, b3]`:
 * `nibble = b0 >> 4`, `duration = (b0&15)<<16 | b1<<8 | b2`, `usage = b3`.
 */
export function decodeStep(b: Uint8Array, i = 0): MacroStep {
  const b0 = b[i] ?? 0;
  const nibble = b0 >> 4;
  // Vendor action map {0:0,1:0,8:1,9:1,2:0,10:1} — everything else → 0.
  const action = nibble >= 8 && nibble <= 10 ? 1 : 0;
  const kind: StepKind =
    nibble === 0 || nibble === 8
      ? 'key'
      : nibble === 1 || nibble === 9
        ? 'modifier'
        : nibble === 2 || nibble === 10
          ? 'mouse'
          : nibble;
  return {
    action,
    delayMs: ((b0 & 0x0f) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0),
    usage: b[i + 3] ?? 0,
    kind,
  };
}

/**
 * Parse the raw cmd-133 region into macro entries. Mirrors the vendor
 * `extractPossibleHeaders` scan exactly: `r = u16le(region[0..2])` is the
 * header-table length; headers are read while `s+3 < r`, a header is
 * accepted only when `len>0 && len<10000 && offset>=r && offset<len(region)
 * && offset+len<=len(region)` (scan stops at the first rejected header),
 * then bodies are consumed sequentially from `r`.
 *
 * An all-zero or empty region yields `[]` — the vendor treats it as "no
 * macros". Malformed entries are decoded leniently rather than failing
 * the whole region.
 */
export function parseMacroRegion(region: Uint8Array): MacroEntry[] {
  if (region.length < 4) return [];
  const r = u16le(region, 0);
  if (r < 4 || r > region.length || r % 4 !== 0) return [];
  // Header scan (vendor: break on first invalid header).
  const headers: [number, number][] = []; // (offset, length)
  let s = 0;
  while (s + 3 < r) {
    const off = u16le(region, s);
    const len = u16le(region, s + 2);
    const plausible =
      len > 0 &&
      len < MAX_ENTRY_LEN &&
      off >= r &&
      off < region.length &&
      off + len <= region.length;
    if (plausible) {
      headers.push([off, len]);
      s += 4;
    } else {
      break;
    }
  }
  // Bodies are consumed sequentially from `r`, ignoring `offset` for
  // positioning (vendor `a.slice(o, o+len)`), exactly like the JS.
  const out: MacroEntry[] = [];
  let o = r;
  for (const [, len] of headers) {
    if (o + len > region.length) break;
    const body = region.subarray(o, o + len);
    o += len;
    out.push(decodeBody(body));
  }
  return out;
}

/** Decode one entry body `[nameLen][name][steps…]` (lenient on truncation). */
function decodeBody(body: Uint8Array): MacroEntry {
  if (body.length === 0) return { name: '', steps: [] };
  const nameLen = body[0] ?? 0;
  const nameBytes = body.subarray(1, Math.min(body.length, 1 + nameLen));
  // Vendor strips zero bytes before the UTF-8 decode.
  const cleaned = nameBytes.filter((b) => b !== 0);
  const name = new TextDecoder('utf-8', { fatal: false }).decode(cleaned);
  const stepsStart = 1 + nameLen;
  const stepsRaw = stepsStart <= body.length ? body.subarray(stepsStart) : new Uint8Array(0);
  const steps: MacroStep[] = [];
  for (let i = 0; i + 3 < stepsRaw.length; i += 4) {
    steps.push(decodeStep(stepsRaw, i));
  }
  return { name, steps };
}

// ── Encode (vendor `assembleGroupsWithLog` write path) ──────────────────

/**
 * Encode one step to its 4 wire bytes. `kind`/`action` select the nibble
 * exactly like the vendor (`base + action*8`); a numeric `kind` (raw
 * Other nibble) writes it verbatim and ignores `action`.
 */
export function encodeStep(step: MacroStep): Uint8Array {
  if (step.action > 1) {
    throw new Error(`macro step action must be 0 or 1, got ${step.action}`);
  }
  if (step.delayMs > MAX_STEP_DURATION) {
    throw new Error(
      `macro step delay ${step.delayMs} ms exceeds 20-bit max ${MAX_STEP_DURATION}`,
    );
  }
  const base = kindBase(step.kind);
  const nibble = base === null ? (step.kind as number) : base + step.action * 8;
  const d = step.delayMs;
  return new Uint8Array([
    ((nibble & 0x0f) << 4) | ((d >> 16) & 0x0f),
    (d >> 8) & 0xff,
    d & 0xff,
    step.usage & 0xff,
  ]);
}

/** Body length: 1 (nameLen) + name bytes + 4·steps. */
export function entryBodyLen(e: MacroEntry): number {
  const nameLen = new TextEncoder().encode(e.name).length;
  if (nameLen > 0xff) {
    throw new Error(`macro name too long: ${nameLen} bytes (max 255)`);
  }
  const len = 1 + nameLen + e.steps.length * 4;
  if (len > 0xffff) {
    throw new Error(`macro '${e.name}' body too large: ${len} bytes`);
  }
  return len;
}

/**
 * Build the assembled (unpadded) macro region for `entries`:
 * `[4·N header bytes][bodies…]`. The whole region must fit in
 * [`MACRO_REGION_BYTES`]; pad with zeros for the wire via
 * [`padMacroRegion`].
 */
export function buildMacroRegion(entries: MacroEntry[]): Uint8Array {
  // Validate + encode bodies first.
  const bodies: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    if (nameBytes.length > 0xff) {
      throw new Error(`macro name too long: ${nameBytes.length} bytes (max 255)`);
    }
    entryBodyLen(e);
    const body = new Uint8Array(entryBodyLen(e));
    body[0] = nameBytes.length;
    body.set(nameBytes, 1);
    let p = 1 + nameBytes.length;
    for (const s of e.steps) {
      body.set(encodeStep(s), p);
      p += 4;
    }
    bodies.push(body);
  }
  const n = entries.length;
  const headerTable = 4 * n;
  const total = headerTable + bodies.reduce((a, b) => a + b.length, 0);
  if (total > MACRO_REGION_BYTES) {
    throw new Error(
      `macro region needs ${total} bytes, max ${MACRO_REGION_BYTES} — delete unused macros first`,
    );
  }
  // Headers: offset = absolute body position, len = body length (LE u16).
  const region = new Uint8Array(total);
  let cursor = headerTable;
  for (let i = 0; i < n; i++) {
    const body = bodies[i]!;
    const h = i * 4;
    region[h] = cursor & 0xff;
    region[h + 1] = (cursor >> 8) & 0xff;
    region[h + 2] = body.length & 0xff;
    region[h + 3] = (body.length >> 8) & 0xff;
    cursor += body.length;
  }
  let pos = headerTable;
  for (const body of bodies) {
    region.set(body, pos);
    pos += body.length;
  }
  return region;
}

/**
 * Zero-pad an assembled region to the fixed 512-byte wire payload the
 * vendor always sends (`p.concat(zeros)` in the JS).
 */
export function padMacroRegion(region: Uint8Array): Uint8Array {
  if (region.length > MACRO_REGION_BYTES) {
    throw new Error(`macro region ${region.length} bytes exceeds ${MACRO_REGION_BYTES}`);
  }
  const out = new Uint8Array(MACRO_REGION_BYTES);
  out.set(region);
  return out;
}

/**
 * Vendor `findFirstNConsecutiveZeros(region, 4)` space check: returns the
 * number of bytes from the first run of ≥4 zero bytes to the end of the
 * region (0 when no such run exists). Used to pre-flight "is there room
 * for another macro" exactly like the MacroConfiguration page.
 */
export function macroFreeSpace(region: Uint8Array): number {
  let run = 0;
  for (let i = 0; i < region.length; i++) {
    if ((region[i] ?? 0) === 0) {
      run += 1;
      if (run === 4) return region.length - (i + 1 - 4);
    } else {
      run = 0;
    }
  }
  return 0;
}

/**
 * Vendor estimate for the space a macro needs
 * (`5 + utf8(name).len + steps*4`, MacroConfiguration page `se()`).
 */
export function macroSpaceNeeded(name: string, steps: number): number {
  return 5 + new TextEncoder().encode(name).length + steps * 4;
}

/**
 * Keymap tag-3 value binding a key slot to macro `index`
 * (`"0x03" + type + num + index` in the vendor JS):
 * `0x03<<24 | type<<16 | num<<8 | index`. `macroType` is the macro type
 * byte (vendor binds with 1) and `num` the loop count (vendor UI default 1).
 */
export function macroKeyValue(macroType: number, num: number, index: number): number {
  return (
    (0x0300_0000 | ((macroType & 0xff) << 16) | ((num & 0xff) << 8) | (index & 0xff)) >>> 0
  );
}

// ── JSON view (docs/macro-schema.md) ────────────────────────────────────

/**
 * JSON view of one step, round-trippable through [`parseStepsJson`]:
 * `{action: "down"|"up", delay_ms, key, usage, kind}` — or the raw-nibble
 * form `{action, delay_ms, usage, kind:"other", nibble}` for unrecognized
 * step kinds (mirrors the Rust `step_json`).
 */
export function stepToJson(s: MacroStep): Record<string, unknown> {
  const action = s.action === 0 ? 'down' : 'up';
  if (typeof s.kind === 'number') {
    return { action, delay_ms: s.delayMs, usage: s.usage, kind: 'other', nibble: s.kind };
  }
  const key = macroNameForUsage(s.usage, s.kind) ?? String(s.usage);
  return {
    action,
    delay_ms: s.delayMs,
    key,
    usage: s.usage,
    kind: s.kind,
  };
}

/** JSON view of one entry `{index, name, steps}` (CLI `macro get`). */
export function entryToJson(index: number, e: MacroEntry): Record<string, unknown> {
  return { index, name: e.name, steps: e.steps.map(stepToJson) };
}

// ── Steps JSON import (docs/macro-schema.md, port of parse_steps_input) ──

/** Parsed `macro set` payload: optional name override + steps. */
export interface StepsInput {
  name: string | null;
  steps: MacroStep[];
}

function parseAction(v: unknown, ctx: string): number {
  if (typeof v === 'string') {
    switch (v.toLowerCase()) {
      case 'down':
      case 'press':
      case 'keydown':
      case '0':
        return 0;
      case 'up':
      case 'release':
      case 'keyup':
      case '1':
        return 1;
      default:
        throw new Error(`${ctx}: bad action '${v}' (want down|up)`);
    }
  }
  if (typeof v === 'number' && Number.isInteger(v)) {
    if (v === 0 || v === 1) return v;
    throw new Error(`${ctx}: action must be 0 or 1`);
  }
  throw new Error(`${ctx}: action must be a string or 0/1`);
}

/**
 * `key` accepts a vendor key name (`"KeyA"`, `"ShiftLeft"`, `"MouseLeft"`),
 * a decimal usage, or `0x` hex. Returns `[usage, kindFromName|null]`.
 */
function parseKey(v: unknown, ctx: string): [number, StepKind | null] {
  if (typeof v === 'string') {
    const t = v.trim();
    const hex = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : null;
    if (hex !== null) {
      const n = Number.parseInt(hex, 16);
      if (Number.isNaN(n) || n > 0xff) {
        throw new Error(`${ctx}: bad hex key '${v}'`);
      }
      return [n, null];
    }
    if (/^\d+$/.test(t)) {
      const n = Number.parseInt(t, 10);
      if (n > 0xff) {
        throw new Error(`${ctx}: key usage ${n} does not fit the step's u8 code byte`);
      }
      return [n, null];
    }
    // Exact vendor name, then case-insensitive fallback.
    let usage = macroUsageForName(t);
    let name: string | null = usage !== null ? t : null;
    if (usage === null) {
      const lower = t.toLowerCase();
      for (const [n2, u] of MACRO_KEY_TABLE) {
        if (n2.toLowerCase() === lower) {
          usage = u;
          name = n2;
          break;
        }
      }
    }
    if (usage === null || name === null) {
      throw new Error(
        `${ctx}: unknown key name '${t}' (want a vendor name like KeyA/ShiftLeft/MouseLeft, a usage number, or 0x hex)`,
      );
    }
    if (usage > 0xff) {
      throw new Error(`${ctx}: key '${t}' has usage ${usage} — not encodable in a macro step`);
    }
    return [usage, defaultKindForName(name)];
  }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
    if (v > 0xff) {
      throw new Error(`${ctx}: key usage ${v} does not fit the step's u8 code byte`);
    }
    return [v, null];
  }
  throw new Error(`${ctx}: key must be a string or number`);
}

function parseKind(v: unknown, nameKind: StepKind | null, ctx: string): StepKind {
  if (v === undefined || v === null) return nameKind ?? 'key';
  if (typeof v === 'string') {
    switch (v.toLowerCase()) {
      case 'key':
        return 'key';
      case 'modifier':
      case 'mod':
        return 'modifier';
      case 'mouse':
        return 'mouse';
      default:
        throw new Error(`${ctx}: bad kind '${v}' (want key|modifier|mouse)`);
    }
  }
  throw new Error(`${ctx}: kind must be a string`);
}

function parseOneStep(v: unknown, i: number): MacroStep {
  const ctx = `steps[${i}]`;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${ctx}: step must be an object`);
  }
  const obj = v as Record<string, unknown>;
  if (!('action' in obj)) throw new Error(`${ctx}: missing 'action'`);
  const action = parseAction(obj.action, ctx);
  const keyV = 'key' in obj ? obj.key : 'code' in obj ? obj.code : undefined;
  if (keyV === undefined) throw new Error(`${ctx}: missing 'key'`);
  const [usage, nameKind] = parseKey(keyV, ctx);
  const delayV = 'delay_ms' in obj ? obj.delay_ms : 'duration' in obj ? obj.duration : undefined;
  let delayMs = 0;
  if (delayV !== undefined && delayV !== null) {
    if (typeof delayV !== 'number' || !Number.isInteger(delayV) || delayV < 0) {
      throw new Error(`${ctx}: delay_ms must be a non-negative integer`);
    }
    delayMs = delayV;
  }
  if (delayMs > MAX_STEP_DURATION) {
    throw new Error(`${ctx}: delay_ms ${delayMs} exceeds the 20-bit wire max ${MAX_STEP_DURATION}`);
  }
  const kind = parseKind('kind' in obj ? obj.kind : undefined, nameKind, ctx);
  return { action, delayMs, usage, kind };
}

/**
 * Parse a steps JSON payload: top level may be a bare step array or
 * `{"name": "…", "steps": […]}` (docs/macro-schema.md). Throws on invalid
 * input — the UI surfaces the message.
 */
export function parseStepsJson(text: string): StepsInput {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`steps JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  let name: string | null = null;
  let arr: unknown;
  if (Array.isArray(v)) {
    arr = v;
  } else if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string') name = o.name;
    arr = 'steps' in o ? o.steps : 'data' in o ? o.data : undefined;
    if (arr === undefined) throw new Error("steps object needs a 'steps' array");
  } else {
    throw new Error('steps JSON must be an array or an object with \'steps\'');
  }
  if (!Array.isArray(arr)) throw new Error('steps must be an array');
  if (arr.length === 0) {
    throw new Error('steps array is empty — to delete a macro remove it from the list instead');
  }
  const steps = arr.map((s, i) => parseOneStep(s, i));
  return { name, steps };
}
