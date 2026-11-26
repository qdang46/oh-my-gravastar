/**
 * Shared modal dialogs — the web UI's replacement for native
 * `window.confirm()` / `window.prompt()` / `alert()`.
 *
 * `confirmDialog()` resolves `true` only on an explicit confirm;
 * backdrop click, Esc and Cancel all resolve `false`. `promptDialog()`
 * resolves the entered string, or `null` on cancel.
 *
 * Styling reuses the vendor Popup tokens in style.css (`.modal-overlay`,
 * `.modal`, `.modal-actions`) — same dark card, lime primary button,
 * red variant for destructive actions.
 *
 * W0: `confirmWrite()` is the ONE confirmation surface for device
 * writes (spec §7). It wraps `confirmDialog` and requires an
 * `WriteImpact` block that states — in plain language — what changes,
 * which keys/regions are affected, whether the change persists, whether
 * a backup was captured, rollback coverage and limits, and whether the
 * device may restart or drop off the bus. Dialogs that are NOT device
 * writes (local scene delete, file validation) may keep using
 * `confirmDialog` directly.
 */

import { t } from './i18n/index.ts';

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

export interface ConfirmDialogOptions {
  title: string;
  /** Plain-text body (newlines preserved). */
  bodyText?: string;
  /** Extra muted note under the body. */
  hint?: string;
  /** Bullet list of specifics (e.g. the exact changes that will be written). */
  details?: string[];
  /**
   * Structured impact block (spec §7) — rendered as a labelled list so
   * every device write states persistence, backup, rollback and
   * restart/disconnect impact. `confirmWrite()` requires it; plain
   * `confirmDialog` callers may add it for device mutations.
   */
  impact?: WriteImpact;
  /** Exact payload shown in a scrollable <pre> (e.g. JSON being sent). */
  preText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive/overwrite actions. */
  danger?: boolean;
}

export interface PromptDialogOptions {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** Return an error message to keep the dialog open, or null to accept. */
  validate?: (value: string) => string | null;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * The §7 impact statement every device-write confirmation must carry.
 * All fields are plain-language strings (or lists); `undefined` fields
 * are omitted from the dialog rather than guessed.
 */
export interface WriteImpact {
  /** Keys / regions / settings touched, e.g. "Key A, layer 2" or "whole macro list". */
  affected?: string[];
  /** Whether the change is stored on the device (survives unplugging). */
  persistent?: boolean;
  /** Whether a backup/snapshot was captured before this write. */
  backupCaptured?: boolean;
  /** Rollback coverage — honest limits, e.g. "keymap + lighting only". */
  rollback?: 'full' | 'partial' | 'none' | string;
  /** Whether the device may restart or drop off the bus during the write. */
  restartRisk?: boolean;
}

/** Render the §7 impact block inside a dialog card. */
function renderImpact(modal: HTMLElement, impact: WriteImpact): void {
  const box = el('div', 'modal-impact');
  box.append(el('h4', 'modal-impact-title', t('confirm.impact.title')));
  const dl = el('dl', 'modal-impact-list');
  const row = (key: string, value: string): void => {
    const dt = el('dt', '', t(key));
    dt.dataset.k = key;
    dl.append(dt, el('dd', '', value));
  };
  if (impact.affected?.length) {
    row('confirm.impact.affected', impact.affected.join(', '));
  }
  if (impact.persistent !== undefined) {
    row(
      'confirm.impact.persistent',
      t(impact.persistent ? 'confirm.impact.persistentYes' : 'confirm.impact.persistentNo'),
    );
  }
  if (impact.backupCaptured !== undefined) {
    row(
      'confirm.impact.backup',
      t(impact.backupCaptured ? 'confirm.impact.backupYes' : 'confirm.impact.backupNo'),
    );
  }
  if (impact.rollback !== undefined) {
    const rb =
      impact.rollback === 'full'
        ? 'confirm.impact.rollbackYes'
        : impact.rollback === 'partial'
          ? 'confirm.impact.rollbackPartial'
          : impact.rollback === 'none'
            ? 'confirm.impact.rollbackNo'
            : null;
    row('confirm.impact.rollback', rb ? t(rb) : String(impact.rollback));
  }
  if (impact.restartRisk !== undefined) {
    row(
      'confirm.impact.restart',
      t(impact.restartRisk ? 'confirm.impact.restartWarn' : 'confirm.impact.restartNone'),
    );
  }
  box.append(dl);
  modal.append(box);
}

export interface WriteConfirmOptions extends Omit<ConfirmDialogOptions, 'impact'> {
  /** Required §7 impact statement — what/where/persistence/backup/undo/restart. */
  impact: WriteImpact;
}

/**
 * The single confirmation surface for device writes. Requires the
 * structured `impact` block so no write path can ship an under-specified
 * dialog; everything else delegates to `confirmDialog`.
 */
export function confirmWrite(opts: WriteConfirmOptions): Promise<boolean> {
  return confirmDialog({ ...opts, impact: opts.impact });
}

interface DialogHandle<T> {
  modal: HTMLElement;
  /** Close with a result; ignores repeat calls. */
  close: (result: T) => void;
  /** Close with the dialog's cancel value (Esc / backdrop / Cancel). */
  cancel: () => void;
}

/**
 * Mount an overlay + card, wire Esc / backdrop / Tab-trap, run `build`
 * to fill the card, and report the result through `onResult` exactly
 * once. `build` receives the handle so buttons can call close/cancel.
 */
function openDialog<T>(
  cancelValue: T,
  build: (h: DialogHandle<T>) => void,
  onResult: (result: T) => void,
): void {
  const overlay = el('div', 'modal-overlay');
  const modal = el('div', 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  overlay.append(modal);
  document.body.append(overlay);

  let settled = false;
  const handle: DialogHandle<T> = {
    modal,
    close: (result: T) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      onResult(result);
    },
    cancel: () => handle.close(cancelValue),
  };

  // Esc cancels; Tab / Shift+Tab cycle inside the dialog.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      handle.cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [
      ...modal.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]'),
    ].filter((n) => !n.hasAttribute('disabled') && n.tabIndex >= 0);
    if (items.length === 0) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey ? active === first || !modal.contains(active) : active === last || !modal.contains(active)) {
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? last : first).focus();
    }
  };
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) handle.cancel();
  });

  build(handle);
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    openDialog<boolean>(
      false,
      (h) => {
        h.modal.append(el('h3', 'modal-title', opts.title));
        if (opts.bodyText) {
          const p = el('p', 'modal-body');
          p.textContent = opts.bodyText;
          h.modal.append(p);
        }
        if (opts.details?.length) {
          const ul = el('ul', 'modal-list');
          for (const line of opts.details) ul.append(el('li', '', line));
          h.modal.append(ul);
        }
        if (opts.impact) renderImpact(h.modal, opts.impact);
        if (opts.preText !== undefined) {
          h.modal.append(el('p', 'hint', 'Exact settings that will be sent:'));
          h.modal.append(el('pre', 'json-view mono', opts.preText));
        }
        if (opts.hint) h.modal.append(el('p', 'hint', opts.hint));

        const row = el('div', 'modal-actions');
        const cancel = el('button', 'btn', opts.cancelLabel ?? t('common.cancel'));
        const ok = el(
          'button',
          `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`,
          opts.confirmLabel ?? t('common.confirm'),
        );
        cancel.type = 'button';
        ok.type = 'button';
        cancel.addEventListener('click', () => h.cancel());
        ok.addEventListener('click', () => h.close(true));
        row.append(cancel, ok);
        h.modal.append(row);

        // Danger dialogs default focus to Cancel so Enter can't destroy
        // anything by accident; everything else focuses the action.
        (opts.danger ? cancel : ok).focus();
      },
      resolve,
    );
  });
}

export function promptDialog(opts: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    openDialog<string | null>(
      null,
      (h) => {
        h.modal.append(el('h3', 'modal-title', opts.title));
        if (opts.label) h.modal.append(el('p', 'hint', opts.label));

        const input = opts.multiline
          ? el('textarea', 'modal-input mono')
          : el('input', 'modal-input');
        if (opts.multiline) {
          (input as HTMLTextAreaElement).rows = 8;
        } else {
          (input as HTMLInputElement).type = 'text';
        }
        input.value = opts.defaultValue ?? '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
        h.modal.append(input);

        const error = el('p', 'hint warn modal-error');
        error.hidden = true;
        h.modal.append(error);

        const row = el('div', 'modal-actions');
        const cancel = el('button', 'btn', opts.cancelLabel ?? t('common.cancel'));
        const ok = el('button', 'btn btn-primary', opts.confirmLabel ?? t('common.ok'));
        cancel.type = 'button';
        ok.type = 'button';
        cancel.addEventListener('click', () => h.cancel());
        ok.addEventListener('click', () => {
          const value = input.value;
          const problem = opts.validate?.(value) ?? null;
          if (problem) {
            error.textContent = problem;
            error.hidden = false;
            return;
          }
          h.close(value);
        });
        input.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter' && !opts.multiline) {
            e.preventDefault();
            ok.click();
          }
        });
        row.append(cancel, ok);
        h.modal.append(row);
        input.focus();
        if (!opts.multiline) (input as HTMLInputElement).select();
      },
      resolve,
    );
  });
}
