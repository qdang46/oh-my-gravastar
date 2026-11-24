/**
 * DOM-free helpers for the Diagnostics page (bead `oq2`) — extracted so
 * `scripts/smoke-diag.ts` can exercise them under plain Node (the page
 * module itself pulls in `state.ts` → `hid.ts`, which uses constructor
 * parameter properties that Node's strip-only TS mode cannot parse).
 *
 * Boot keyboard report decoding follows the USB HID spec "boot
 * protocol" keyboard format: byte 0 = modifier bitmap, byte 1 =
 * reserved, bytes 2..7 = up to 6 pressed keycodes (HID usage ids).
 * khub916 does not document per-key input on its vendor
 * feature-report channel, so the page treats these as whatever the
 * keyboard's standard HID interface emits; non-8-byte reports are
 * counted as unrecognised, never decoded.
 */

import { decodeKeyValue } from './proto/khub916.ts';

/** Modifier bit index → HID usage id (0xE0..0xE7). */
const MOD_USAGE_BASE = 0xe0;

export const MODIFIER_LABELS: Record<number, string> = {
  0xe0: 'Left Ctrl',
  0xe1: 'Left Shift',
  0xe2: 'Left Alt',
  0xe3: 'Left GUI',
  0xe4: 'Right Ctrl',
  0xe5: 'Right Shift',
  0xe6: 'Right Alt',
  0xe7: 'Right GUI',
};

export interface BootKeyState {
  /** Modifier bitmap byte (bits 0..7, L→R order per HID spec). */
  modifiers: number;
  /** Modifier usages currently down (0xE0..0xE7). */
  modUsages: number[];
  /** Pressed key usages (HID usage ids, boot slots only). */
  usages: number[];
}

/**
 * Decode an 8-byte boot keyboard report. Returns null for any other
 * length — callers count those as unrecognised vendor/NKRO traffic.
 */
export function decodeBootKeyboardReport(data: Uint8Array): BootKeyState | null {
  if (data.length !== 8) return null;
  const modifiers = data[0] ?? 0;
  const modUsages: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    if (modifiers & (1 << bit)) modUsages.push(MOD_USAGE_BASE + bit);
  }
  const usages: number[] = [];
  for (let i = 2; i < 8; i++) {
    const u = data[i] ?? 0;
    if (u !== 0) usages.push(u);
  }
  return { modifiers, modUsages, usages };
}

/**
 * HID usages a khub916 keymap value "presses" in boot-report terms.
 * `normal` values contribute their usage plus left-modifier usages for
 * set modifier bits; every other kind (macro/Fn/SOCD/…) contributes
 * nothing — those keys cannot be matched to a physical press.
 */
export function pressTokensForValue(v: number): number[] {
  const kv = decodeKeyValue(v >>> 0);
  if (kv.kind !== 'normal') return [];
  const tokens: number[] = [];
  if (kv.usage !== 0) tokens.push(kv.usage);
  if (kv.ctrl) tokens.push(0xe0);
  if (kv.shift) tokens.push(0xe1);
  if (kv.alt) tokens.push(0xe2);
  if (kv.gui) tokens.push(0xe3);
  return tokens;
}

/** Lowercase-free uppercase hex dump for unrecognised reports. */
export function hexBytes(bytes: Uint8Array, max = 96): string {
  const slice = bytes.subarray(0, max);
  const s = Array.from(slice, (x) => x.toString(16).padStart(2, '0')).join(' ');
  return bytes.length > max ? `${s} …` : s;
}

// ── Extended diagnostics (bead 7l0) ────────────────────────────────────
//
// Everything below is DOM-free and works on plain timestamps so
// `scripts/smoke-diag.ts` can exercise it under Node. The measurements
// are deliberately honest about their boundary:
//
// - `RolloverTracker` counts *OS-delivered* `KeyboardEvent`s. It says
//   nothing about the device's matrix wiring; it shows how many keys the
//   browser/OS stack delivered simultaneously (the part NKRO vs 6KRO
//   actually changes for the user).
// - `ChatterTracker` derives press/release transitions from successive
//   decoded HID reports. Durations are quantised by the report cadence —
//   a "chatter" flag is a heuristic hint, not a firmware measurement.
// - `ReportCadence` measures inter-report arrival gaps (delivery rate),
//   not the keyboard's scan rate.

/** Combined usage set (modifiers + keycodes) of a decoded boot report. */
export function bootPressedUsages(boot: BootKeyState): Set<number> {
  const s = new Set<number>(boot.usages);
  for (const u of boot.modUsages) s.add(u);
  return s;
}

// ── Rollover test ──────────────────────────────────────────────────────

export interface RolloverSnapshot {
  /** Physical `KeyboardEvent.code`s currently held (sorted). */
  held: string[];
  heldCount: number;
  /** Max simultaneous keys seen since the tracker was created/reset. */
  peak: number;
  /** Distinct (non-repeat) keydowns. */
  presses: number;
  /** Keyups matching a held key. */
  releases: number;
  /** Auto-repeat keydowns ignored (key already held). */
  repeats: number;
  /** Keys cleared by `reset()` (window blur) without a keyup. */
  lostReleases: number;
  /** Keyups with no matching keydown (e.g. focus gained mid-press). */
  orphanReleases: number;
}

/**
 * Tracks simultaneously-held keys from `keydown`/`keyup` codes.
 * `down`/`up` take the event's `code` (layout-independent physical
 * position — 'KeyA' is the A-position key on every layout, matching how
 * HID usages are named). Repeat keydowns for an already-held code are
 * counted separately so holding one key cannot inflate the peak.
 */
export class RolloverTracker {
  private readonly held = new Set<string>();
  private presses = 0;
  private releases = 0;
  private repeats = 0;
  private lost = 0;
  private orphan = 0;
  private peak = 0;

  down(code: string): void {
    if (this.held.has(code)) {
      this.repeats += 1;
      return;
    }
    this.held.add(code);
    this.presses += 1;
    if (this.held.size > this.peak) this.peak = this.held.size;
  }

  up(code: string): void {
    if (this.held.delete(code)) {
      this.releases += 1;
    } else {
      this.orphan += 1;
    }
  }

  /**
   * Drop every held key (window blur / test stop): still-held keys are
   * counted as lost releases so the summary stays honest.
   */
  reset(): void {
    this.lost += this.held.size;
    this.held.clear();
  }

  snapshot(): RolloverSnapshot {
    return {
      held: [...this.held].sort(),
      heldCount: this.held.size,
      peak: this.peak,
      presses: this.presses,
      releases: this.releases,
      repeats: this.repeats,
      lostReleases: this.lost,
      orphanReleases: this.orphan,
    };
  }
}

// ── Chatter / press-timing from the HID report stream ─────────────────

/** A usage is a chatter suspect after this many presses… */
export const CHATTER_MIN_PRESSES = 4;
/** …with a completed press shorter than this many ms. */
export const CHATTER_MIN_PRESS_MS = 30;

export interface UsageTiming {
  usage: number;
  presses: number;
  releases: number;
  /** presses + releases. */
  transitions: number;
  /** Shortest completed press→release duration seen (null = none yet). */
  minPressMs: number | null;
  /** Most recent completed press duration. */
  lastPressMs: number | null;
  /** Currently down since this timestamp (null = up). */
  downAt: number | null;
  /** Heuristic chatter flag — see CHATTER_MIN_*. */
  chatter: boolean;
}

function timingOf(u: UsageTiming): UsageTiming {
  u.transitions = u.presses + u.releases;
  u.chatter =
    u.presses >= CHATTER_MIN_PRESSES &&
    u.minPressMs !== null &&
    u.minPressMs < CHATTER_MIN_PRESS_MS;
  return u;
}

/**
 * Diffs successive pressed-usage sets (one `feed` per decoded boot
 * report) and accumulates per-usage press timing. Timestamps are the
 * caller's clock (ms); durations are therefore quantised by however
 * often reports arrive — treat sub-interval values as "at least this
 * fast", never as microsecond truth.
 */
export class ChatterTracker {
  private prev = new Set<number>();
  private readonly byUsage = new Map<number, UsageTiming>();

  private entry(u: number): UsageTiming {
    let t = this.byUsage.get(u);
    if (!t) {
      t = {
        usage: u,
        presses: 0,
        releases: 0,
        transitions: 0,
        minPressMs: null,
        lastPressMs: null,
        downAt: null,
        chatter: false,
      };
      this.byUsage.set(u, t);
    }
    return t;
  }

  feed(pressed: Iterable<number>, now: number): void {
    const next = new Set(pressed);
    for (const u of next) {
      if (this.prev.has(u)) continue;
      const t = this.entry(u);
      t.presses += 1;
      t.downAt = now;
      timingOf(t);
    }
    for (const u of this.prev) {
      if (next.has(u)) continue;
      const t = this.entry(u);
      t.releases += 1;
      if (t.downAt !== null) {
        const d = Math.max(0, now - t.downAt);
        t.lastPressMs = d;
        t.minPressMs = t.minPressMs === null ? d : Math.min(t.minPressMs, d);
        t.downAt = null;
      }
      timingOf(t);
    }
    this.prev = next;
  }

  /** Per-usage timings, most transitions first. */
  all(): UsageTiming[] {
    return [...this.byUsage.values()].sort(
      (a, b) => b.transitions - a.transitions || a.usage - b.usage,
    );
  }

  /** Only usages flagged as chatter suspects. */
  suspects(): UsageTiming[] {
    return this.all().filter((t) => t.chatter);
  }

  reset(): void {
    this.prev.clear();
    this.byUsage.clear();
  }
}

// ── Input-report cadence ──────────────────────────────────────────────

export interface CadenceStats {
  /** Inter-report gaps measured (reports − 1). */
  samples: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
}

/**
 * Inter-arrival gaps between consecutive input reports — a delivery
 * cadence measurement (browser/WebHID path), NOT the keyboard scan
 * rate. Needs ≥2 reports before `stats()` returns non-null.
 */
export class ReportCadence {
  private lastAt = 0;
  private samples = 0;
  private min = Infinity;
  private max = 0;
  private sum = 0;

  push(now: number): void {
    if (this.lastAt !== 0) {
      const d = now - this.lastAt;
      if (d >= 0) {
        this.samples += 1;
        this.sum += d;
        if (d < this.min) this.min = d;
        if (d > this.max) this.max = d;
      }
    }
    this.lastAt = now;
  }

  stats(): CadenceStats | null {
    if (this.samples === 0) return null;
    return {
      samples: this.samples,
      minMs: this.min,
      avgMs: this.sum / this.samples,
      maxMs: this.max,
    };
  }

  reset(): void {
    this.lastAt = 0;
    this.samples = 0;
    this.min = Infinity;
    this.max = 0;
    this.sum = 0;
  }
}
