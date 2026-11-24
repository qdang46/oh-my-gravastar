/**
 * Shared edit-session model — bead oh-my-gravastar-sl3.
 *
 * One interaction model for every editing page: Edit → Preview → Apply →
 * Verify, surfaced as a consistent bottom/top bar:
 *
 *   [N unsaved changes]  [extra controls…]  [Discard]  [Apply]
 *
 * This module owns ONLY the presentation/state plumbing — it never sends
 * bytes and never decides what "a change" is. Each page keeps its own
 * dirty tracking (StagedEdits pending counts, LightingView draft diff,
 * MacroPage draft compare) and reports the pending count here; the bar
 * renders badge + Apply/Discard identically everywhere.
 *
 * Layers:
 * - DOM-free: `EditSession` (dirty-state bookkeeping) and
 *   `editBarViewModel`/`pendingBadgeText` (pure view model) — unit-tested
 *   under plain Node (`scripts/test-edit-model.ts`);
 * - DOM: `createEditBar`/`syncEditBar` — a thin wrapper that builds the
 *   bar once and re-syncs it on every page render pass.
 *
 * Status reporting stays on the global `setStatus` line (shell.ts) — the
 * same channel every page already uses for per-op results.
 */

// ── DOM-free core ─────────────────────────────────────────────────────

/**
 * Dirty-state tracker shared by editing pages. Pages push their pending
 * change count (or a boolean dirty flag mapped to 0/1) via `setPending`;
 * the bar reads `pending`/`isDirty`/`busy`.
 *
 * `busy` marks an in-flight write: Apply/Discard disable while set, and
 * `note` carries an optional one-line reason shown next to the badge
 * (e.g. "writes immediately — not part of staged Save").
 */
export class EditSession {
  private pendingCount = 0;
  private busyFlag = false;
  private noteText = '';

  /** Number of unsaved changes (0 = clean). */
  get pending(): number {
    return this.pendingCount;
  }

  get isDirty(): boolean {
    return this.pendingCount > 0;
  }

  get busy(): boolean {
    return this.busyFlag;
  }

  /** Optional hint rendered beside the badge ('' = none). */
  get note(): string {
    return this.noteText;
  }

  /** Replace the pending count (absolute, not a delta). */
  setPending(n: number): void {
    this.pendingCount = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  /** Mark `busy` while a write is in flight. */
  setBusy(b: boolean): void {
    this.busyFlag = b;
  }

  /** Set/clear the badge note. */
  setNote(text: string): void {
    this.noteText = text;
  }

  /** Reset to the clean state (after a successful Apply). */
  reset(): void {
    this.pendingCount = 0;
    this.busyFlag = false;
    this.noteText = '';
  }
}

/** Badge text for a pending count; '' when clean (badge hidden). */
export function pendingBadgeText(pending: number): string {
  if (pending <= 0) return '';
  return `${pending} unsaved change${pending === 1 ? '' : 's'}`;
}

/**
 * Everything the Apply button needs to render itself.
 * `applyLabel` may be a static string or a function of
 * `(pending, busy)` so pages can say "Save all (3)" / "Saving…".
 */
export interface EditBarState {
  /** Unsaved change count; 0 = clean. */
  pending: number;
  /** Write in flight — both buttons disable and Apply shows busy text. */
  busy?: boolean;
  /** Apply label; default 'Save'. */
  applyLabel?: string | ((pending: number, busy: boolean) => string);
  applyTitle?: string;
  /** Discard label; default 'Discard changes'. */
  discardLabel?: string;
  discardTitle?: string;
  /** Optional extra control rendered between badge and buttons
   *  (e.g. the Keys page's "Review changes" diff toggle). */
  extra?: HTMLElement | null;
  /** Page-specific extra gate on top of `pending === 0` (e.g. an empty
   *  macro draft). Defaults to `pending === 0`. */
  applyDisabled?: boolean;
  /** Optional note shown beside the badge. */
  note?: string;
  onApply?: () => void;
  onDiscard?: () => void;
}

export interface EditBarViewModel {
  badgeText: string;
  badgeHidden: boolean;
  noteText: string;
  noteHidden: boolean;
  applyText: string;
  applyDisabled: boolean;
  discardText: string;
  discardDisabled: boolean;
}

function resolveLabel(
  label: string | ((pending: number, busy: boolean) => string) | undefined,
  fallback: string,
  pending: number,
  busy: boolean,
): string {
  if (typeof label === 'function') return label(pending, busy);
  return label ?? fallback;
}

/**
 * Pure view model for the edit bar — the state machine is simply
 * clean → dirty → busy → clean/dirty. Apply is enabled only when there
 * is something pending and no write is in flight (unless the page
 * overrides via `applyDisabled`, which can only further disable).
 */
export function editBarViewModel(state: EditBarState): EditBarViewModel {
  const pending = Math.max(0, Math.floor(state.pending));
  const busy = state.busy === true;
  const applyDisabled = busy || pending === 0 || state.applyDisabled === true;
  const badgeText = pendingBadgeText(pending);
  const noteText = state.note ?? '';
  return {
    badgeText,
    badgeHidden: badgeText === '',
    noteText,
    noteHidden: noteText === '',
    applyText: resolveLabel(state.applyLabel, 'Save', pending, busy),
    applyDisabled,
    discardText: state.discardLabel ?? 'Discard changes',
    discardDisabled: busy || pending === 0,
  };
}

// ── DOM wrapper ────────────────────────────────────────────────────────

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

export interface EditBarView {
  root: HTMLElement;
  badge: HTMLElement;
  note: HTMLElement;
  apply: HTMLButtonElement;
  discard: HTMLButtonElement;
}

/**
 * Build the shared edit bar once; call `syncEditBar` on every page sync
 * to refresh badge/buttons from the current `EditBarState`.
 * `extra` is an optional control (e.g. a diff toggle) placed between the
 * badge and the buttons — pass the same element each sync.
 */
export function createEditBar(state: EditBarState): EditBarView {
  const root = el('div', 'edit-bar');
  const badge = el('span', 'chip edit-badge', '');
  const note = el('span', 'hint edit-note', '');
  const apply = el('button', 'btn btn-primary edit-apply', '') as HTMLButtonElement;
  apply.type = 'button';
  const discard = el('button', 'btn edit-discard', '') as HTMLButtonElement;
  discard.type = 'button';
  apply.addEventListener('click', () => state.onApply?.());
  discard.addEventListener('click', () => state.onDiscard?.());
  root.append(badge, note);
  if (state.extra) root.append(state.extra);
  root.append(discard, apply);
  const view: EditBarView = { root, badge, note, apply, discard };
  syncEditBar(view, state);
  return view;
}

/** Refresh a previously created bar from a fresh state. */
export function syncEditBar(view: EditBarView, state: EditBarState): void {
  const vm = editBarViewModel(state);
  view.badge.textContent = vm.badgeText;
  view.badge.hidden = vm.badgeHidden;
  view.note.textContent = vm.noteText;
  view.note.hidden = vm.noteHidden;
  view.apply.textContent = vm.applyText;
  view.apply.disabled = vm.applyDisabled;
  if (state.applyTitle !== undefined) view.apply.title = state.applyTitle;
  view.discard.textContent = vm.discardText;
  view.discard.disabled = vm.discardDisabled;
  if (state.discardTitle !== undefined) view.discard.title = state.discardTitle;
  // Extra control may arrive after creation (first sync has no DOM slot).
  if (state.extra && state.extra.parentElement !== view.root) {
    view.root.insertBefore(state.extra, view.discard);
  }
}
