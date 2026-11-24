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
 */

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
        if (opts.preText !== undefined) {
          h.modal.append(el('p', 'hint', 'Exact settings that will be sent:'));
          h.modal.append(el('pre', 'json-view mono', opts.preText));
        }
        if (opts.hint) h.modal.append(el('p', 'hint', opts.hint));

        const row = el('div', 'modal-actions');
        const cancel = el('button', 'btn', opts.cancelLabel ?? 'Cancel');
        const ok = el(
          'button',
          `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`,
          opts.confirmLabel ?? 'Confirm',
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
        const cancel = el('button', 'btn', opts.cancelLabel ?? 'Cancel');
        const ok = el('button', 'btn btn-primary', opts.confirmLabel ?? 'OK');
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
