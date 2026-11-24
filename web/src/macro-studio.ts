/**
 * Macro Studio helpers — pure logic for the Macro page
 * (`web/src/macro.ts`), kept DOM-free so `scripts/` smoke tests can
 * exercise it under Node's TS stripping.
 *
 * Covers bead oh-my-gravastar-uol: step validation (unreleased keys,
 * stuck modifiers, over-long delays, storage overflow, unknown key
 * codes), macro-region byte accounting against the 512 B wire region
 * (docs/macro-schema.md §"Wire recap"), and the text used by the
 * step search/filter box.
 */

import {
  MACRO_KEY_TABLE,
  MACRO_REGION_BYTES,
  MAX_STEP_DURATION,
  buildMacroRegion,
  macroNameForUsage,
  type MacroEntry,
  type MacroStep,
  type StepKind,
} from './proto/macro916.ts';

// ── Validator ───────────────────────────────────────────────────────────

export type IssueLevel = 'error' | 'warn';

export interface MacroIssue {
  /** 'error' = will fail or misbehave on the keyboard; 'warn' = suspicious. */
  level: IssueLevel;
  /** Step index the issue belongs to, or null for whole-macro issues. */
  step: number | null;
  /** Plain-language description (shown verbatim in the panel). */
  message: string;
}

/**
 * A pause longer than this gets a "very long" warning. The wire field
 * allows up to ~17 minutes; anything over ~5 s almost always means a
 * recording glitch rather than intentional timing.
 */
export const LONG_DELAY_WARN_MS = 5000;

/** Nibble base for pairing purposes (same mapping as the wire). */
function kindBaseOf(kind: StepKind): number {
  switch (kind) {
    case 'key':
      return 0;
    case 'modifier':
      return 1;
    case 'mouse':
      return 2;
    default:
      return kind; // raw/other nibble
  }
}

/** Identity of the physical key a step presses/releases. */
function stepKeyId(step: MacroStep): string {
  return `${step.usage}:${kindBaseOf(step.kind)}`;
}

function isModifierStep(step: MacroStep): boolean {
  if (step.kind === 'modifier') return true;
  // Numeric kinds are raw nibbles — only nibble bases 1/9 are modifiers,
  // and those decode to 'modifier' already, so numbers never match.
  return false;
}

/** Friendly display for one step's key, for messages and tooltips. */
export function stepKeyLabel(step: MacroStep): string {
  const name = macroNameForUsage(step.usage, step.kind);
  if (name !== null) return name;
  return `key code ${step.usage}`;
}

/**
 * Validate a draft step list. Returns issues sorted by step index;
 * whole-macro issues (step === null) come first. Does NOT throw and
 * never blocks saving — the panel is advisory; hard failures still
 * surface from `buildMacroRegion` at save time.
 */
export function validateMacroSteps(steps: MacroStep[]): MacroIssue[] {
  const issues: MacroIssue[] = [];

  // ── Pairing: every press should have a release and vice versa. ──
  // `pressed` maps key id → stack of step indices still held down.
  const pressed = new Map<string, number[]>();
  steps.forEach((step, i) => {
    const id = stepKeyId(step);
    const label = stepKeyLabel(step);
    if (step.action === 0) {
      const stack = pressed.get(id) ?? [];
      if (stack.length > 0) {
        issues.push({
          level: 'warn',
          step: i,
          message: `Step ${i} presses ${label} again while it is still held from step ${stack[stack.length - 1]} — the keyboard may ignore the repeat.`,
        });
      }
      stack.push(i);
      pressed.set(id, stack);
    } else {
      const stack = pressed.get(id);
      if (!stack || stack.length === 0) {
        issues.push({
          level: 'warn',
          step: i,
          message: `Step ${i} releases ${label}, but it was never pressed — this step does nothing.`,
        });
      } else {
        stack.pop();
        if (stack.length === 0) pressed.delete(id);
      }
    }
  });
  // Whatever is still held at the end never got its release.
  const leftovers = [...pressed.entries()].sort((a, b) => a[1][0]! - b[1][0]!);
  for (const [id, stack] of leftovers) {
    const first = stack[0]!;
    const step = steps[first]!;
    const label = stepKeyLabel(step);
    const where = stack.length > 1 ? ` (pressed ${stack.length} times, first at step ${first})` : '';
    issues.push({
      level: isModifierStep(step) ? 'error' : 'warn',
      step: first,
      message: isModifierStep(step)
        ? `Modifier ${label} is pressed at step ${first} but never released${where} — it will stay held for the rest of the macro and may stick until the keyboard resets.`
        : `${label} is pressed at step ${first} but never released${where} — it stays held until the macro ends.`,
    });
  }

  // ── Per-step field checks. ──
  steps.forEach((step, i) => {
    if (!Number.isInteger(step.delayMs) || step.delayMs < 0) {
      issues.push({
        level: 'error',
        step: i,
        message: `Step ${i} has an invalid pause of ${step.delayMs} ms — pauses must be whole milliseconds ≥ 0.`,
      });
    } else if (step.delayMs > MAX_STEP_DURATION) {
      issues.push({
        level: 'error',
        step: i,
        message: `Step ${i} pause of ${step.delayMs} ms is too large — the keyboard stores at most ${MAX_STEP_DURATION.toLocaleString()} ms per step.`,
      });
    } else if (step.delayMs > LONG_DELAY_WARN_MS) {
      issues.push({
        level: 'warn',
        step: i,
        message: `Step ${i} waits ${(step.delayMs / 1000).toFixed(1)} s — an unusually long pause; check it was intended.`,
      });
    }

    if (!Number.isInteger(step.action) || (step.action !== 0 && step.action !== 1)) {
      issues.push({
        level: 'error',
        step: i,
        message: `Step ${i} has an invalid action ${step.action} — only press (0) or release (1) can be stored.`,
      });
    }

    if (!Number.isInteger(step.usage) || step.usage < 0 || step.usage > 0xff) {
      issues.push({
        level: 'error',
        step: i,
        message: `Step ${i} uses key code ${step.usage}, which does not fit the 1-byte code the keyboard stores — pick a key from the list instead.`,
      });
    } else if (typeof step.kind === 'number') {
      issues.push({
        level: 'warn',
        step: i,
        message: `Step ${i} uses an advanced/raw key type (code ${step.kind}) — only change it if you imported this macro from a file.`,
      });
    } else if (macroNameForUsage(step.usage, step.kind) === null) {
      issues.push({
        level: 'warn',
        step: i,
        message: `Step ${i} uses key code ${step.usage}, which has no name in the vendor key table — it will be stored as a raw code.`,
      });
    }
  });

  // Stable order: whole-macro issues first, then by step index.
  issues.sort((a, b) => (a.step ?? -1) - (b.step ?? -1));
  return issues;
}

// ── Storage accounting (512 B region) ──────────────────────────────────

/**
 * Bytes one entry occupies in the region: 4-byte header slot + body
 * (`1 nameLen + UTF-8 name + 4·steps`). Throws on an over-long name —
 * callers treat that as "does not fit".
 */
export function macroEntryBytes(e: MacroEntry): number {
  const nameLen = new TextEncoder().encode(e.name).length;
  if (nameLen > 0xff) {
    throw new Error(`macro name too long: ${nameLen} bytes (max 255)`);
  }
  const body = 1 + nameLen + e.steps.length * 4;
  if (body > 0xffff) throw new Error(`macro '${e.name}' body too large`);
  return 4 + body;
}

/**
 * Bytes the assembled (unpadded) region needs for `entries` — what a
 * save would actually send before zero-padding. Returns null when the
 * entries cannot be encoded at all (the save path will report the
 * real error); callers should fall back to `macroEntryBytes` sums.
 */
export function macroRegionUsedBytes(entries: MacroEntry[]): number | null {
  try {
    return buildMacroRegion(entries).length;
  } catch {
    return null;
  }
}

/** Sum of per-entry bytes; ignores encode failures (best-effort). */
export function macroRegionUsedBytesFallback(entries: MacroEntry[]): number {
  let total = 0;
  for (const e of entries) {
    try {
      total += macroEntryBytes(e);
    } catch {
      total += MACRO_REGION_BYTES; // unencodable — counts as "full"
    }
  }
  return total;
}

/** Used bytes for display: exact when encodable, else the fallback sum. */
export function macroRegionUsed(entries: MacroEntry[]): number {
  return macroRegionUsedBytes(entries) ?? macroRegionUsedBytesFallback(entries);
}

export interface RegionProjection {
  /** Estimated region bytes after applying the draft. */
  usedBytes: number;
  capacityBytes: number;
  fits: boolean;
  /** Whole-region issue, or null when it fits. */
  problem: string | null;
}

/**
 * Project the 512 B region usage with `draft` applied: `slot` is the
 * index being replaced, or `entries.length` (append) / `null` when the
 * draft is not part of the list. Used for the editor's storage line
 * and the "will it fit?" warning before save.
 */
export function projectRegionUsage(
  entries: MacroEntry[],
  slot: number | null,
  draft: MacroEntry | null,
): RegionProjection {
  const capacityBytes = MACRO_REGION_BYTES;
  let list: MacroEntry[];
  if (draft === null) {
    list = entries;
  } else if (slot === null) {
    list = entries;
  } else if (slot >= entries.length) {
    list = [...entries, draft];
  } else {
    list = entries.slice();
    list[slot] = draft;
  }
  const usedBytes = macroRegionUsed(list);
  const fits = usedBytes <= capacityBytes;
  return {
    usedBytes,
    capacityBytes,
    fits,
    problem: fits
      ? null
      : `Saving would need about ${usedBytes} bytes of the ${capacityBytes}-byte macro region — delete or shorten other macros first.`,
  };
}

// ── Step search/filter ─────────────────────────────────────────────────

/**
 * Lowercased haystack for the step filter box: friendly vendor name,
 * raw key code, action word and pause. Matches the same strings the
 * timeline tooltip shows.
 */
export function stepSearchText(step: MacroStep): string {
  const parts = [
    step.action === 0 ? 'press down' : 'release up',
    stepKeyLabel(step),
    `code ${step.usage}`,
    `${step.delayMs} ms`,
    `${(step.delayMs / 1000).toFixed(3)} s`,
  ];
  // Also index every vendor name that maps to this usage so e.g.
  // "mouse left" finds MouseLeft even though the label is the name.
  for (const [name, usage] of MACRO_KEY_TABLE) {
    if (usage === step.usage) parts.push(name.toLowerCase());
  }
  return parts.join(' ').toLowerCase();
}

/** ms → compact human string for tooltips/labels ("8 ms", "1.5 s"). */
export function formatDelay(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  }
  return `${ms} ms`;
}
