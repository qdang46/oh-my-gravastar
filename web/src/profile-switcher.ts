/**
 * profile-switcher.ts — bead 0hl: game/app profile switcher UI.
 *
 * A "saved profile" is a named ProfileHistoryEntry — the snapshots the
 * Version history card (profiles.ts) already captures automatically and
 * manually. This card lists them with name / capture time / device
 * model / a compatibility badge, and offers:
 *
 *   - Apply — writes the whole snapshot back through the SAME hardened
 *     restore path as Version history (`applyWholeEntry` → validate →
 *     parse → `applyParsedImport`: pre-write backup, transaction
 *     journal, best-effort rollback). Two-click arm, like the restore
 *     panel; model-mismatch profiles get the extra confirm inside
 *     `applyParsedImport`. Protocol-incompatible profiles can't be
 *     applied at all (compat badge shows why).
 *   - Save current as profile — name prompt → `captureNamedSnapshot` →
 *     marked active (the keyboard provably holds that state).
 *   - Active profile indicator + bounded switch log in localStorage
 *     (`ProfileSwitcherStore`, profile-switcher-core.ts).
 *
 * PLATFORM LIMIT (bead 0hl, honest by design): a browser page CANNOT
 * detect which app or game is in the foreground, so there is no
 * auto-switch trigger here — switching is manual. The CLI-side
 * `omg profile watch` foreground-app trigger is planned follow-up
 * work; the copy below says so instead of pretending.
 */

import { app, emit, setStatus, subscribe } from './state.ts';
import { promptDialog } from './modal.ts';
import type { DeviceLike } from './core/device-model.ts';
import type { ProfileHistoryEntry } from './profile-history.ts';
import {
  applyWholeEntry,
  captureNamedSnapshot,
  profileHistoryStore,
} from './profiles.ts';
import {
  ProfileSwitcherStore,
  buildProfileList,
  type CompatStatus,
  type ProfileCompat,
  type SwitchOutcome,
} from './profile-switcher-core.ts';

// ── DOM helpers (same style as profiles.ts / pages-secondary.ts) ──────

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

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// ── State ─────────────────────────────────────────────────────────────

let store: ProfileSwitcherStore | null = null;
function switcher(): ProfileSwitcherStore {
  store ??= new ProfileSwitcherStore();
  return store;
}

let applyArmedFor: string | null = null;
let applyBusy = false;
let saveBusy = false;
let log: string[] = [];

/** Connected-device identity for the compatibility badge. */
function deviceLike(): DeviceLike | null {
  const c = app.connected;
  const snap = app.snapshot;
  if (!c || !snap) return null;
  const dev = c.device;
  return {
    vendorId: dev.vendorId,
    productId: dev.productId,
    productName: dev.productName ?? null,
    usagePage: c.collection.usagePage,
    usage: c.collection.usage,
    uuid: snap.info.uuid,
    catalogModel: snap.info.catalogModel,
    catalogName: snap.info.catalogName,
    screenSize: snap.info.screenSize,
  };
}

const COMPAT_LABEL: Record<CompatStatus, string> = {
  ok: 'fits this keyboard',
  warning: 'model differs — confirm on apply',
  error: 'incompatible',
  unknown: 'compat unchecked',
};

function compatBadge(compat: ProfileCompat): HTMLElement {
  const cls =
    compat.status === 'ok'
      ? 'hint ok'
      : compat.status === 'warning' || compat.status === 'error'
        ? 'hint warn'
        : 'hint';
  const detail = [...compat.errors, ...compat.warnings].join(' ');
  const b = el('span', `prof-compat ${cls}`, COMPAT_LABEL[compat.status]);
  if (detail) b.title = detail;
  return b;
}

// ── Outcome classification ────────────────────────────────────────────
// Maps the human-readable lines `applyWholeEntry` returns onto the
// switch-log outcome. Kept conservative: anything that isn't clearly a
// clean apply is 'failed' (or 'cancelled'), never 'applied'.

const FAILED_RE =
  /FAILED|Stopped early|ABORTED|cannot be applied|failed validation|no writable sections/i;

function classifyOutcome(lines: readonly string[]): SwitchOutcome {
  const text = lines.join('\n');
  if (FAILED_RE.test(text)) return 'failed';
  if (/cancelled/i.test(text)) return 'cancelled';
  return 'applied';
}

// ── Actions ───────────────────────────────────────────────────────────

async function applyEntry(id: string): Promise<void> {
  const entry: ProfileHistoryEntry | null = profileHistoryStore().get(id);
  if (!entry) {
    log = ['That profile no longer exists — pick another.'];
    applyArmedFor = null;
    emit();
    return;
  }
  applyBusy = true;
  applyArmedFor = null;
  log = [];
  emit();
  try {
    const lines = await applyWholeEntry(entry);
    const outcome = classifyOutcome(lines);
    switcher().recordSwitch({
      ts: new Date().toISOString(),
      profileId: entry.id,
      name: entry.name,
      outcome,
    });
    // Only a fully-applied profile becomes "the active profile" — a
    // partial/failed write leaves the keyboard in a mixed state and
    // must not be labelled as that profile.
    if (outcome === 'applied') switcher().setActive(entry.id);
    log = lines;
    if (outcome === 'applied') setStatus(`Applied profile "${entry.name}".`);
  } catch (e) {
    switcher().recordSwitch({
      ts: new Date().toISOString(),
      profileId: entry.id,
      name: entry.name,
      outcome: 'failed',
    });
    log = [`Apply failed: ${msg(e)}`];
  } finally {
    applyBusy = false;
    emit();
  }
}

async function saveCurrentAsProfile(): Promise<void> {
  const name = await promptDialog({
    title: 'Save current as profile',
    label:
      'Name this profile — e.g. the game or app it is for. It is stored ' +
      'in this browser only and can be applied back later.',
    defaultValue: `profile ${new Date().toLocaleString()}`,
    validate: (v) => (v.trim() ? null : 'Give the profile a name.'),
    confirmLabel: 'Save',
  });
  if (name === null) return;
  saveBusy = true;
  log = [];
  emit();
  try {
    const entry = await captureNamedSnapshot(name.trim());
    if (entry) {
      // The keyboard provably holds this state right now.
      switcher().setActive(entry.id);
      log = [`Profile "${entry.name}" saved — marked as the active profile.`];
    } else {
      log = ['Could not read the keyboard state — nothing was saved.'];
    }
  } catch (e) {
    log = [`Could not save the profile: ${msg(e)}`];
  } finally {
    saveBusy = false;
    emit();
  }
}

// ── Render ────────────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<SwitchOutcome, string> = {
  applied: 'applied',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * Append the "Game & app profiles" card to the config page root. Called
 * by `renderConfig` in pages-secondary.ts on every re-render — all
 * interactive state lives in module vars above.
 */
export function renderProfileSwitcher(root: HTMLElement): void {
  const entries = profileHistoryStore().list();
  const like = deviceLike();
  const items = buildProfileList(entries, like);
  const activeId = switcher().activeId();
  const activeEntry = activeId ? entries.find((e) => e.id === activeId) : undefined;
  const connected = like !== null;

  const c = card('Game & app profiles');
  c.body.append(
    el(
      'p',
      'hint',
      'A saved profile is a named snapshot of everything stored on the ' +
        'keyboard (the same data Version history keeps below). Apply ' +
        'writes it back through the usual checked restore path — a backup ' +
        'is taken first and every part is verified on the keyboard.',
    ),
    el(
      'p',
      'hint warn',
      'Switching is manual: a browser page cannot see which app or game ' +
        'is in the foreground, so it cannot switch profiles automatically. ' +
        'Automatic per-app switching is planned for the omg CLI ' +
        '(`omg profile watch`) — it is not available from this page yet.',
    ),
  );

  // ── Active profile indicator ──
  const activeLine = el('p', activeEntry ? 'hint ok' : 'hint');
  activeLine.append(
    document.createTextNode('Active profile: '),
    el('strong', '', activeEntry ? activeEntry.name : 'none'),
  );
  activeLine.append(
    document.createTextNode(
      activeEntry
        ? ` — saved ${fmtTs(activeEntry.ts)}.`
        : ' — applying a profile (or saving the current state) marks it active.',
    ),
  );
  c.body.append(activeLine);

  // ── Save current ──
  const actions = el('div', 'sec-actions');
  const saveBtn = el('button', 'sec-btn', 'Save current as profile');
  saveBtn.type = 'button';
  saveBtn.disabled = saveBusy || applyBusy || !connected;
  saveBtn.title = connected ? '' : 'Saving a profile needs a connected keyboard';
  saveBtn.addEventListener('click', () => void saveCurrentAsProfile());
  actions.append(saveBtn);
  c.body.append(actions);

  // ── Profile list ──
  if (items.length === 0) {
    c.body.append(
      el(
        'p',
        'hint',
        'No saved profiles yet — they appear here after the first ' +
          'snapshot (saved automatically after each change, or via ' +
          '“Save current as profile” / “Save current state” below).',
      ),
    );
  } else {
    const ul = el('ul', 'prof-list');
    items.forEach((item, i) => {
      const li = el('li', 'prof-row');
      const meta = el('div', 'prof-meta');
      const nameRow = el('div', 'prof-name');
      nameRow.append(document.createTextNode(item.name));
      if (item.id === activeId) {
        nameRow.append(el('span', 'prof-active', ' — active'));
      }
      meta.append(nameRow);
      meta.append(
        el(
          'div',
          'prof-ts',
          [
            `#${entries.length - i}`,
            fmtTs(item.ts),
            item.model ?? 'model unknown',
            `${item.sections} section(s)`,
          ].join(' · '),
        ),
      );
      const acts = el('div', 'prof-actions');
      const applyBtn = el(
        'button',
        'prof-btn',
        applyArmedFor === item.id
          ? `Yes — write "${item.name}" to the keyboard`
          : 'Apply',
      );
      applyBtn.type = 'button';
      applyBtn.disabled =
        applyBusy ||
        saveBusy ||
        !connected ||
        item.compat.status === 'error' ||
        item.sections === 0;
      applyBtn.title =
        item.compat.status === 'error'
          ? (item.compat.errors[0] ?? 'incompatible with this keyboard')
          : !connected
            ? 'Connect a keyboard first'
            : item.compat.status === 'warning'
              ? (item.compat.warnings[0] ?? 'model differs — you will be asked to confirm')
              : '';
      applyBtn.addEventListener('click', () => {
        if (applyArmedFor !== item.id) {
          applyArmedFor = item.id;
          emit();
          return;
        }
        void applyEntry(item.id);
      });
      acts.append(applyBtn, compatBadge(item.compat));
      li.append(meta, acts);
      ul.append(li);
    });
    c.body.append(ul);
    c.body.append(
      el(
        'p',
        'hint',
        'Apply restores every section in the snapshot. Profiles captured ' +
          'for a different keyboard model ask for confirmation; profiles ' +
          'for a different protocol cannot be applied here.',
      ),
    );
  }

  // ── Recent switches ──
  const recents = switcher().switches().slice(0, 6);
  if (recents.length) {
    c.body.append(el('h3', 'prof-sub', 'Recent switches'));
    const sul = el('ul', 'fact-list');
    for (const r of recents) {
      sul.append(
        el('li', '', `${fmtTs(r.ts)} — ${r.name} — ${OUTCOME_LABEL[r.outcome]}`),
      );
    }
    c.body.append(sul);
  }

  if (log.length) {
    const pre = el('pre', 'sec-log');
    pre.textContent = log.join('\n');
    c.body.append(pre);
  }
  root.append(c.card);
}

/**
 * Dashboard summary: active profile name + switch count. Cheap
 * localStorage reads only — safe to call on every dashboard render.
 */
export function profileSwitcherSummary(): {
  activeName: string | null;
  switchCount: number;
} {
  const id = switcher().activeId();
  const entry = id ? profileHistoryStore().get(id) : null;
  return {
    activeName: entry?.name ?? null,
    switchCount: switcher().switches().length,
  };
}

// Reset transient UI state when the device drops.
subscribe(() => {
  if (!app.connected) {
    applyArmedFor = null;
    applyBusy = false;
    saveBusy = false;
    log = [];
  }
});
