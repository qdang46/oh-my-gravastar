/**
 * Fn-layer doctor — session/UI glue for `fn-doctor-core.ts`
 * (bead oh-my-gravastar-fn-layer-doctor-yw0, web half).
 *
 * `fnDoctorReport()` performs the two READ-ONLY keymap queries the
 * check needs — arg `0x01` (Fn layer) and arg `0x00` (base layer) —
 * through the shared `ensureKeymap` path, so results land in the
 * snapshot cache and repeated calls (Diagnostics card, dashboard
 * warning) cost nothing extra. Queries are issued SEQUENTIALLY: this
 * firmware interleaves concurrent feature reports and poisons the
 * session (see state/connection.ts).
 *
 * The result is memoized per connected device. Nothing here writes,
 * resets, or suggests any device mutation — the check is diagnostic
 * only (AGENTS.md §Safety 1/2).
 */

import { app, ensureKeymap } from './state.ts';
import { physicalLayoutForModel } from './layout-model.ts';
import {
  analyzeFnLayer,
  BASE_LAYER_ARG,
  FN_LAYER_ARG,
  type FnDoctorReport,
} from './fn-doctor-core.ts';

// ── Memoized report (per connected device) ─────────────────────────────

let cacheConn: unknown = null;
let cachePromise: Promise<FnDoctorReport | null> | null = null;

/**
 * Run (or return the cached) Fn-layer check. Resolves `null` when no
 * device is connected or the Fn-layer read came back empty; rejects
 * only on a transport/protocol error, which callers may surface.
 */
export function fnDoctorReport(): Promise<FnDoctorReport | null> {
  const conn = app.connected;
  if (!conn || !app.snapshot) return Promise.resolve(null);
  if (cacheConn !== conn || !cachePromise) {
    cacheConn = conn;
    const p = load();
    cachePromise = p;
    // A failed read is not cached — the next render may retry.
    p.catch(() => {
      if (cachePromise === p) cachePromise = null;
    });
  }
  return cachePromise;
}

async function load(): Promise<FnDoctorReport | null> {
  // Sequential reads — never Promise.all on this transport.
  const fnEntries = await ensureKeymap(FN_LAYER_ARG);
  if (fnEntries.length === 0) return null;
  const baseEntries = await ensureKeymap(BASE_LAYER_ARG);

  const snap = app.snapshot;
  const layout = physicalLayoutForModel(snap?.info.catalogModel ?? null);

  // Physical slot → name map, plus the Fn key's slot — both derived
  // from the vendor layout table for this model, never hardcoded.
  let physical: Map<number, string> | null = null;
  let fnKeyIndex: number | null = null;
  let fnKeyName: string | null = null;
  if (layout) {
    physical = new Map<number, string>();
    for (const k of layout.keys) {
      if (!k.display) continue;
      const name = k.name || `slot ${k.keyIndex}`;
      physical.set(k.keyIndex, name);
      if (fnKeyIndex === null && /^fn$/i.test(k.name.trim())) {
        fnKeyIndex = k.keyIndex;
        fnKeyName = k.name;
      }
    }
  }

  return analyzeFnLayer(
    fnEntries.map((e) => e.value >>> 0),
    baseEntries.map((e) => e.value >>> 0),
    { physical, fnKeyIndex, fnKeyName },
  );
}

// ── DOM rendering (used by Diagnostics; dashboard only needs the
//    report fields, not this) ──────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const LIST_CAP = 24;

/**
 * Paint a report into `box` (replacing its children). Read-only
 * presentation — verdict line, dead-slot list, opaque count, Fn-key
 * status and a "what this means" hint.
 */
export function renderFnDoctorInto(box: HTMLElement, r: FnDoctorReport): void {
  box.replaceChildren();

  const verdict = el(
    'p',
    r.intact ? 'fn-doc-verdict fn-doc-verdict--ok' : 'fn-doc-verdict fn-doc-verdict--bad',
    r.summary,
  );
  box.append(verdict);

  if (r.dead.length > 0) {
    const shown = r.dead.slice(0, LIST_CAP);
    const ul = el('ul', 'fn-doc-list');
    for (const s of shown) {
      ul.append(el('li', '', `${s.name} (slot ${s.index}) — 0x00000000`));
    }
    if (r.dead.length > shown.length) {
      ul.append(el('li', 'fn-doc-more', `…and ${r.dead.length - shown.length} more`));
    }
    box.append(el('p', 'fn-doc-label', 'Keys with no Fn action:'), ul);
  }

  if (r.opaque.length > 0) {
    box.append(
      el(
        'p',
        'fn-doc-note',
        `${r.opaque.length} slot${r.opaque.length === 1 ? '' : 's'} hold opaque values ` +
          'the app cannot decode (e.g. undocumented tag-0x08 Fn actions). ' +
          'They are shown as raw hex elsewhere and are never rewritten by this check.',
      ),
    );
  }

  switch (r.fnKey.status) {
    case 'fn':
      box.append(
        el(
          'p',
          'fn-doc-note',
          `Fn key check: ${r.fnKey.name ?? `slot ${r.fnKey.index}`} still switches to ` +
            'the Fn layer in the base keymap (arg 0x00).',
        ),
      );
      break;
    case 'empty':
      box.append(
        el(
          'p',
          'fn-doc-note fn-doc-note--bad',
          `Fn key check: ${r.fnKey.name ?? `slot ${r.fnKey.index}`} reads 0x00000000 ` +
            'in the base layer — the key has no binding at all.',
        ),
      );
      break;
    case 'rebound':
      box.append(
        el(
          'p',
          'fn-doc-note fn-doc-note--bad',
          `Fn key check: ${r.fnKey.name ?? `slot ${r.fnKey.index}`} is bound to ` +
            `${r.fnKey.label ?? 'a non-Fn action'} instead of the Fn layer.`,
        ),
      );
      break;
    case 'unreadable':
      box.append(
        el(
          'p',
          'fn-doc-note',
          `Fn key check: could not read base-layer slot ${r.fnKey.index} ` +
            '(the base keymap read was incomplete).',
        ),
      );
      break;
    case 'no-layout':
      box.append(
        el(
          'p',
          'fn-doc-note',
          'Fn key check: skipped — no layout table for this model, so the ' +
            'Fn key position is unknown.',
        ),
      );
      break;
  }

  box.append(
    el(
      'p',
      'hint',
      `Read ${r.slotCount} slots from keymap arg 0x${r.fnArg.toString(16)} ` +
        '(Fn layer) and arg 0x00 (base layer). This check is read-only — ' +
        'it sends queries only and never writes to the keyboard.',
    ),
  );
}
