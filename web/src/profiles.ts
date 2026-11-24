/**
 * profiles.ts — bead th0: profile version history UI, diff view,
 * section restore and auto-capture. Lives on the "Backup & restore"
 * (config) page — the Profiles & Safety surface from UIUX-SPEC §2.7.
 *
 * The PURE half — schema-v1 `state` extraction (`stateOfDoc`), content
 * hashing (`profileStateHash`), per-section diff (`diffProfileStates`)
 * and the bounded `ProfileHistory` store — lives in
 * `./profile-history.ts` (no DOM/device imports, smoke-tested). This
 * file re-exports those symbols so callers have one entry point.
 *
 * Auto-capture wraps the connected session's `write*` methods so every
 * successful profile write — from ANY page (keys, lighting, macro,
 * advanced, config, sleep) — schedules a debounced post-write snapshot.
 * The wrapper is observe-only: args, results and error behaviour are
 * untouched, and the capture itself only READS the device (via
 * `buildProfileExport`). `writeGifFrame` is deliberately not wrapped —
 * music streaming fires ~30 writes/s and isn't a profile change.
 *
 * Restore NEVER bypasses the hardened import path: a stored doc goes
 * through `validateProfileJson` → `parseProfileImport` (validation gate +
 * `canApplyProfile` compat check) → `applyParsedImport`
 * (`snapshotBeforeWrite` + `runTransaction`) — the exact pipeline the
 * file-import button uses.
 */

import { app, emit, setStatus, subscribe } from './state.ts';
import {
  applyParsedImport,
  buildProfileExport,
  parseProfileImport,
  type ParsedImport,
} from './pages-secondary.ts';
import { confirmDialog, promptDialog } from './modal.ts';
import { validateProfileJson } from './safety/index.ts';
import {
  PROFILE_SECTIONS,
  ProfileHistory,
  RESTORABLE_SECTIONS,
  diffProfileStates,
  profileStateHash,
  sectionSummary,
  sectionsInState,
  stateOfDoc,
  type ProfileDoc,
  type ProfileHistoryEntry,
  type ProfileSectionDef,
  type ProfileSectionId,
  type ProfileState,
  type SectionDiff,
} from './profile-history.ts';

// Re-export the pure API for callers/tests that only know profiles.ts.
export {
  PROFILE_HISTORY_KEY,
  PROFILE_HISTORY_MAX,
  PROFILE_SECTIONS,
  RESTORABLE_SECTIONS,
  ProfileHistory,
  diffProfileStates,
  memoryProfileStorage,
  profileStateHash,
  sectionSummary,
  sectionsInState,
  stateOfDoc,
} from './profile-history.ts';
export type {
  DiffLine,
  ProfileDoc,
  ProfileHistoryEntry,
  ProfileSectionDef,
  ProfileSectionId,
  ProfileState,
  ProfileStorage,
  SectionDiff,
} from './profile-history.ts';

// ── DOM helpers (mirrors pages-secondary.ts — keep self-contained) ─────

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

function card(title: string): { card: HTMLElement; body: HTMLElement } {
  const c = el('section', 'card');
  c.append(el('h2', '', title));
  const body = el('div', 'card-body');
  c.append(body);
  return { card: c, body };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── History singleton ──────────────────────────────────────────────────

let historyStore: ProfileHistory | null = null;
function history(): ProfileHistory {
  historyStore ??= new ProfileHistory();
  return historyStore;
}

/** Shared history store — also used by the profile switcher (bead 0hl). */
export function profileHistoryStore(): ProfileHistory {
  return history();
}

// ── Capture (build a doc from the live device) ─────────────────────────

function newEntryId(): string {
  return `hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read the current device state via `buildProfileExport()` and store it.
 * Returns the entry, or null when there is nothing capturable. `dedupe`
 * skips the write when the newest entry already holds identical content
 * (e.g. an advanced-key write that doesn't touch the exported sections).
 */
async function captureEntry(name: string, dedupe: boolean): Promise<ProfileHistoryEntry | null> {
  const doc = (await buildProfileExport()) as ProfileDoc;
  const state = stateOfDoc(doc);
  if (!state) return null;
  const hash = profileStateHash(state);
  if (dedupe && history().list()[0]?.hash === hash) return null;
  const entry: ProfileHistoryEntry = {
    id: newEntryId(),
    ts: new Date().toISOString(),
    name,
    hash,
    doc,
  };
  history().add(entry);
  return entry;
}

// ── Auto-capture: wrap session write methods ───────────────────────────

const AUTO_PREFIX = 'auto · ';

/** [session method, capture reason] — all return WriteOutcome. */
const WRITE_METHODS: readonly (readonly [string, string])[] = [
  ['writeKeymap', 'keymap write'],
  ['writeMacroRegion', 'macro write'],
  ['writeProfile', 'profile write'],
  ['writeCustomLightColors', 'colour write'],
  ['writeLightData', 'lighting write'],
  ['writeKeyConfiguration', 'advanced-key write'],
  ['writeAdvKeyConfig', 'advanced-key write'],
];

const patchedSessions = new WeakSet<object>();

function patchSession(session: unknown): void {
  if (!session || typeof session !== 'object' || patchedSessions.has(session)) return;
  patchedSessions.add(session);
  const s = session as Record<string, unknown>;
  for (const [method, reason] of WRITE_METHODS) {
    const orig = s[method];
    if (typeof orig !== 'function') continue;
    s[method] = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const p = (orig as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      return p.then((out) => {
        // The write resolved (verified or sent-unconfirmed) — schedule a
        // post-write snapshot. Thrown writes never reach this.
        scheduleAutoCapture(`${AUTO_PREFIX}${reason}`);
        return out;
      });
    };
  }
}

const CAPTURE_DEBOUNCE_MS = 1500;
let captureTimer: ReturnType<typeof setTimeout> | null = null;
let pendingName = `${AUTO_PREFIX}change`;
let capturing = false;
let captureQueued = false;

function scheduleAutoCapture(name: string): void {
  pendingName = name;
  if (captureTimer !== null) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    void runAutoCapture();
  }, CAPTURE_DEBOUNCE_MS);
}

/**
 * Wait for the device to go idle (a refresh or another write may still
 * be in flight — concurrent feature reports poison the session), then
 * capture. Sets `app.busy` while reading so page buttons stay disabled.
 */
async function runAutoCapture(): Promise<void> {
  for (let i = 0; i < 40 && app.busy; i++) await sleep(250);
  if (app.busy || !app.connected || !app.snapshot) return;
  if (capturing) {
    captureQueued = true;
    return;
  }
  capturing = true;
  try {
    app.busy = true;
    emit();
    const entry = await captureEntry(pendingName, true);
    app.busy = false;
    emit();
    if (entry) setStatus(`Saved a profile snapshot (${entry.name}).`);
  } catch {
    // Capture is best-effort — a failed read must never break a write.
    app.busy = false;
    emit();
  } finally {
    capturing = false;
    if (captureQueued) {
      captureQueued = false;
      scheduleAutoCapture(pendingName);
    }
  }
}

let baselineSession: unknown = null;
let historyStarted = false;

/**
 * Wire auto-capture: patch each new session's write methods and take a
 * baseline snapshot once per connection (the "previous state" undo needs
 * even when the first write happens before any capture). Idempotent.
 */
export function initProfileHistory(): void {
  if (historyStarted) return;
  historyStarted = true;
  subscribe(() => {
    const c = app.connected;
    if (!c) {
      baselineSession = null;
      return;
    }
    patchSession(c.session);
    if (baselineSession !== c.session && app.snapshot && !app.busy) {
      baselineSession = c.session;
      scheduleAutoCapture(`${AUTO_PREFIX}connected`);
    }
  });
}

// ── UI state (persists across the page's per-emit re-renders) ──────────

const CURRENT = 'current';

let cmpA = '';
let cmpB = '';
let diffResult: { aLabel: string; bLabel: string; sections: SectionDiff[] } | null = null;
let diffBusy = false;
let opBusy = false;
let opLog: string[] = [];
let restoreFor: string | null = null;
let restoreArmed = false;
let restoreSel = new Set<ProfileSectionId>();

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function sectionsOfEntry(e: ProfileHistoryEntry): ProfileSectionDef[] {
  return sectionsInState(stateOfDoc(e.doc));
}

// ── Actions ────────────────────────────────────────────────────────────

async function saveCurrentSnapshot(): Promise<void> {
  const name = await promptDialog({
    title: 'Save current state',
    label: 'Name for this snapshot — it is stored in this browser only.',
    defaultValue: `manual ${new Date().toLocaleString()}`,
    validate: (v) => (v.trim() ? null : 'Give the snapshot a name.'),
    confirmLabel: 'Save',
  });
  if (name === null) return;
  opBusy = true;
  opLog = [];
  emit();
  try {
    const entry = await captureEntry(name.trim(), false);
    opLog = entry
      ? [`Snapshot "${entry.name}" saved (${entry.id}).`]
      : ['Could not read the keyboard state — nothing was saved.'];
  } catch (e) {
    opLog = [`Could not save the snapshot: ${msg(e)}`];
  } finally {
    opBusy = false;
    emit();
  }
}

function allRestorableIn(entry: ProfileHistoryEntry): Set<ProfileSectionId> {
  const state = stateOfDoc(entry.doc);
  return new Set(
    RESTORABLE_SECTIONS.filter((d) => state?.[d.stateKey] !== undefined).map((d) => d.id),
  );
}

/** Clone `doc` keeping only the wanted writable sections in `state`. */
function docWithSections(doc: ProfileDoc, wanted: ReadonlySet<ProfileSectionId>): ProfileDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as ProfileDoc;
  const state = stateOfDoc(clone);
  if (state) {
    for (const def of PROFILE_SECTIONS) {
      if (!wanted.has(def.id)) delete state[def.stateKey];
    }
  }
  return clone;
}

/**
 * Shared restore tail: doc → validate → parse → hardened apply. Used by
 * both the per-section picker and undo. Returns the result lines.
 */
async function restoreDoc(
  entry: ProfileHistoryEntry,
  label: string,
  wanted: ReadonlySet<ProfileSectionId>,
): Promise<string[]> {
  const doc = docWithSections(entry.doc, wanted);
  const text = JSON.stringify(doc, null, 2);
  const v = validateProfileJson(text);
  if (!v.ok) {
    return [
      `Snapshot "${entry.name}" failed validation — nothing was written.`,
      ...v.errors.slice(0, 10),
    ];
  }
  let parsed: ParsedImport;
  try {
    parsed = parseProfileImport(text, `${label} (${entry.ts})`);
  } catch (e) {
    return [`Snapshot "${entry.name}" cannot be applied: ${msg(e)}`];
  }
  if (parsed.compatErrors.length) {
    return [
      `Snapshot "${entry.name}" cannot be applied to this keyboard:`,
      ...parsed.compatErrors,
    ];
  }
  if (parsed.sections.length === 0) {
    return [`Snapshot "${entry.name}" has no writable sections selected.`];
  }
  return applyParsedImport(parsed);
}

/**
 * Capture the live device state under an explicit name — the switcher's
 * "Save current as profile" flow (bead 0hl). Returns the entry, or null
 * when there is nothing capturable.
 */
export async function captureNamedSnapshot(
  name: string,
): Promise<ProfileHistoryEntry | null> {
  return captureEntry(name, false);
}

/**
 * Apply EVERY restorable section of a history entry through the same
 * validated restore path as the section picker (bead 0hl — the profile
 * switcher's "Apply"). Returns the result lines; does not touch the
 * active-profile store (profile-switcher.ts owns that).
 */
export async function applyWholeEntry(entry: ProfileHistoryEntry): Promise<string[]> {
  return restoreDoc(entry, `profile apply ${entry.name}`, allRestorableIn(entry));
}

async function runRestore(entry: ProfileHistoryEntry): Promise<void> {
  opBusy = true;
  restoreArmed = false;
  opLog = [];
  emit();
  try {
    const wanted = restoreSel.size > 0 ? restoreSel : allRestorableIn(entry);
    opLog = await restoreDoc(entry, `history restore ${entry.name}`, wanted);
  } catch (e) {
    opLog = [`Restore failed: ${msg(e)}`];
  } finally {
    opBusy = false;
    restoreFor = null;
    emit();
  }
}

/**
 * Undo = restore the newest saved state that differs from what the
 * device currently holds — i.e. the snapshot taken before the last
 * effective write. Goes through the same validated restore path.
 */
async function undoLastWrite(): Promise<void> {
  if (!app.connected) {
    opLog = ['Connect a keyboard first.'];
    emit();
    return;
  }
  opBusy = true;
  opLog = [];
  emit();
  try {
    const curDoc = (await buildProfileExport()) as ProfileDoc;
    const curHash = profileStateHash(stateOfDoc(curDoc));
    const target = history().list().find((e) => e.hash !== curHash);
    if (!target) {
      opLog = ['Already at the newest saved state — there is nothing to undo.'];
      return;
    }
    const secs = sectionsOfEntry(target)
      .map((d) => d.title)
      .join(', ');
    const ok = await confirmDialog({
      title: 'Undo last change?',
      bodyText:
        `Restore the state saved at ${fmtTs(target.ts)} (${target.name})? ` +
        'This writes the saved values back to the keyboard; a backup of the ' +
        'current state is taken first.',
      details: secs ? [`Sections: ${secs}`] : undefined,
      confirmLabel: 'Undo — restore previous state',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) {
      opLog = ['Undo cancelled — the keyboard was not changed.'];
      return;
    }
    opLog = await restoreDoc(target, `undo → ${target.name}`, allRestorableIn(target));
  } catch (e) {
    opLog = [`Undo failed: ${msg(e)}`];
  } finally {
    opBusy = false;
    emit();
  }
}

async function runDiff(): Promise<void> {
  diffBusy = true;
  diffResult = null;
  opLog = [];
  emit();
  try {
    const entries = history().list();
    const resolve = async (sel: string): Promise<{ label: string; state: ProfileState | null }> => {
      if (sel === CURRENT) {
        const doc = (await buildProfileExport()) as ProfileDoc;
        return { label: 'current device state', state: stateOfDoc(doc) };
      }
      const e = entries.find((x) => x.id === sel);
      return {
        label: e ? `${e.name} · ${fmtTs(e.ts)}` : sel,
        state: e ? stateOfDoc(e.doc) : null,
      };
    };
    const a = await resolve(cmpA || CURRENT);
    const b = await resolve(cmpB || CURRENT);
    diffResult = {
      aLabel: a.label,
      bLabel: b.label,
      sections: diffProfileStates(a.state, b.state),
    };
  } catch (e) {
    opLog = [`Could not build the comparison: ${msg(e)}`];
  } finally {
    diffBusy = false;
    emit();
  }
}

function downloadEntryJson(e: ProfileHistoryEntry): void {
  const blob = new Blob([JSON.stringify(e.doc, null, 2) + '\n'], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `omg-profile-${e.ts.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ── Render ─────────────────────────────────────────────────────────────

function compareSelect(
  value: string,
  entries: readonly ProfileHistoryEntry[],
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select', 'prof-select');
  const cur = el('option', '', 'Current device state');
  cur.value = CURRENT;
  sel.append(cur);
  entries.forEach((e, i) => {
    const o = el('option', '', `#${entries.length - i} ${e.name} — ${fmtTs(e.ts)}`);
    o.value = e.id;
    sel.append(o);
  });
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderDiff(host: HTMLElement): void {
  if (!diffResult) return;
  const box = el('div', 'prof-diff');
  box.append(
    el(
      'p',
      'hint',
      `Comparing “${diffResult.aLabel}” → “${diffResult.bLabel}”. ` +
        'Left column is the first snapshot, right column the second.',
    ),
  );
  let total = 0;
  for (const s of diffResult.sections) {
    total += s.lines.length;
    const sec = el('div', 'prof-diff-section');
    sec.append(el('div', 'prof-diff-title', `${s.title} — ${s.lines.length} change(s)`));
    if (s.lines.length === 0) {
      sec.append(el('div', 'prof-diff-clean', 'no changes'));
    } else {
      const head = el('div', 'prof-diff-line prof-diff-head');
      head.append(el('span', '', 'location'), el('span', '', 'before'), el('span', '', 'after'));
      sec.append(head);
      for (const ln of s.lines) {
        const row = el('div', 'prof-diff-line');
        row.append(
          el('span', 'prof-diff-path', ln.path),
          el('span', 'prof-diff-before', ln.before),
          el('span', 'prof-diff-after', ln.after),
        );
        if (ln.note) row.title = ln.note;
        sec.append(row);
      }
    }
    box.append(sec);
  }
  if (total === 0) {
    box.append(el('p', 'hint ok', 'The two states are identical.'));
  }
  const close = el('button', 'sec-btn', 'Close comparison');
  close.type = 'button';
  close.addEventListener('click', () => {
    diffResult = null;
    emit();
  });
  const row = el('div', 'sec-actions');
  row.append(close);
  box.append(row);
  host.append(box);
}

function renderRestorePanel(host: HTMLElement, entry: ProfileHistoryEntry): void {
  const panel = el('div', 'prof-restore');
  const state = stateOfDoc(entry.doc);
  const avail = RESTORABLE_SECTIONS.filter((d) => state?.[d.stateKey] !== undefined);
  if (avail.length === 0) {
    panel.append(el('p', 'hint warn', 'This snapshot has no restorable sections.'));
    host.append(panel);
    return;
  }
  // Keep the selection valid for this entry.
  for (const id of [...restoreSel]) {
    if (!avail.some((d) => d.id === id)) restoreSel.delete(id);
  }
  if (restoreSel.size === 0) {
    for (const d of avail) restoreSel.add(d.id);
  }
  panel.append(
    el(
      'p',
      'hint',
      `Restore selected sections from “${entry.name}” (${fmtTs(entry.ts)}). ` +
        'A backup of the current state is saved first; each part is checked on the keyboard.',
    ),
  );
  const checks = el('div', 'prof-checks');
  for (const d of avail) {
    const label = el('label', 'prof-check');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = restoreSel.has(d.id);
    cb.addEventListener('change', () => {
      if (cb.checked) restoreSel.add(d.id);
      else restoreSel.delete(d.id);
    });
    label.append(cb, document.createTextNode(` ${d.title} — ${sectionSummary(state, d)}`));
    checks.append(label);
  }
  panel.append(checks);
  const row = el('div', 'sec-actions');
  const go = el(
    'button',
    'sec-btn sec-btn-danger',
    restoreArmed ? `Yes — write ${restoreSel.size} section(s) to the keyboard` : 'Restore selected',
  );
  go.type = 'button';
  go.disabled = opBusy || app.busy || restoreSel.size === 0;
  go.addEventListener('click', () => {
    if (!restoreArmed) {
      restoreArmed = true;
      emit();
      return;
    }
    void runRestore(entry);
  });
  const cancel = el('button', 'sec-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => {
    restoreFor = null;
    restoreArmed = false;
    emit();
  });
  row.append(go, cancel);
  panel.append(row);
  host.append(panel);
}

/**
 * Append the Version history card to the config page root. Called by
 * `renderConfig` in pages-secondary.ts — safe to call on every re-render
 * (all interactive state lives in module vars above).
 */
export function renderProfileHistory(root: HTMLElement): void {
  const entries = history().list();
  const connected = app.connected !== null && app.snapshot !== null;

  const c = card('Version history');
  c.body.append(
    el(
      'p',
      'hint',
      'Snapshots of everything stored on the keyboard are saved automatically ' +
        'after each change (and once when a keyboard connects). Compare any ' +
        'two, restore selected parts, or undo the last change. Stored in this ' +
        'browser only — the newest 20 are kept.',
    ),
  );

  const actions = el('div', 'sec-actions');
  const saveBtn = el('button', 'sec-btn', 'Save current state');
  saveBtn.type = 'button';
  saveBtn.disabled = opBusy || diffBusy || !connected;
  saveBtn.addEventListener('click', () => void saveCurrentSnapshot());
  const undoBtn = el('button', 'sec-btn sec-btn-danger', 'Undo last write');
  undoBtn.type = 'button';
  undoBtn.disabled = opBusy || diffBusy || !connected || entries.length === 0;
  undoBtn.title = 'Restore the newest saved state that differs from the keyboard';
  undoBtn.addEventListener('click', () => void undoLastWrite());
  actions.append(saveBtn, undoBtn);
  c.body.append(actions);

  // ── Compare ──
  const aVal = cmpA || entries[0]?.id || CURRENT;
  const bVal = cmpB || CURRENT;
  const cmpRow = el('div', 'sec-actions prof-selects');
  cmpRow.append(
    compareSelect(aVal, entries, (v) => {
      cmpA = v;
      emit();
    }),
    el('span', 'hint', '→'),
    compareSelect(bVal, entries, (v) => {
      cmpB = v;
      emit();
    }),
  );
  const diffBtn = el('button', 'sec-btn', diffBusy ? 'Comparing…' : 'Show differences');
  diffBtn.type = 'button';
  diffBtn.disabled = diffBusy || opBusy || (!connected && (aVal === CURRENT || bVal === CURRENT));
  diffBtn.title = connected
    ? ''
    : 'Reading the current device state needs a connected keyboard — pick two snapshots instead';
  diffBtn.addEventListener('click', () => void runDiff());
  cmpRow.append(diffBtn);
  c.body.append(cmpRow);

  // ── Entry list ──
  if (entries.length === 0) {
    c.body.append(el('p', 'hint', 'No snapshots yet — they appear here after the first change.'));
  } else {
    const ul = el('ul', 'prof-list');
    entries.forEach((e, i) => {
      const li = el('li', 'prof-row');
      const meta = el('div', 'prof-meta');
      meta.append(el('div', 'prof-name', e.name));
      const badges = sectionsOfEntry(e)
        .map((d) => d.short)
        .join(' · ');
      meta.append(
        el(
          'div',
          'prof-ts',
          `#${entries.length - i} · ${fmtTs(e.ts)}${badges ? ` · ${badges}` : ''}`,
        ),
      );
      const acts = el('div', 'prof-actions');
      const mk = (label: string, fn: () => void): HTMLButtonElement => {
        const b = el('button', 'prof-btn', label);
        b.type = 'button';
        b.disabled = opBusy || diffBusy;
        b.addEventListener('click', fn);
        return b;
      };
      acts.append(
        mk('Diff vs current', () => {
          cmpA = e.id;
          cmpB = CURRENT;
          void runDiff();
        }),
        mk('Restore…', () => {
          restoreFor = restoreFor === e.id ? null : e.id;
          restoreArmed = false;
          restoreSel = new Set<ProfileSectionId>();
          emit();
        }),
        mk('JSON', () => downloadEntryJson(e)),
        mk('✕', () => {
          void (async () => {
            const ok = await confirmDialog({
              title: 'Delete this snapshot?',
              bodyText: `“${e.name}” (${fmtTs(e.ts)}) will be removed from this browser. The keyboard is not affected.`,
              confirmLabel: 'Delete',
              danger: true,
            });
            if (ok) {
              history().remove(e.id);
              if (restoreFor === e.id) restoreFor = null;
              if (cmpA === e.id) cmpA = '';
              if (cmpB === e.id) cmpB = '';
              emit();
            }
          })();
        }),
      );
      li.append(meta, acts);
      ul.append(li);
    });
    c.body.append(ul);
    const restoring = entries.find((e) => e.id === restoreFor);
    if (restoring) renderRestorePanel(c.body, restoring);
  }

  renderDiff(c.body);

  if (opLog.length) {
    const pre = el('pre', 'sec-log');
    pre.textContent = opLog.join('\n');
    c.body.append(pre);
  }
  root.append(c.card);
}
