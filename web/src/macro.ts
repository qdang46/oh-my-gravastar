/**
 * Macro page — clone of the vendor `MacroConfiguration` page
 * (`docs/research/khub-webapp/MacroConfiguration-Ta4bfAz7.js`).
 *
 * Lists the named macros stored in the khub916 macro region (cmd 133,
 * decoded by `proto/macro916.ts`), edits their step lists
 * (action/key/delay, reorder, add/remove), binds a keymap slot to a
 * macro via the tag-3 key value `0x03 TT NN II`, and deletes entries.
 *
 * Writes mirror `crates/omg/src/kb916_macro.rs`: the whole region is
 * rebuilt, zero-padded to 512 B and sent as one cmd-5 feature report,
 * then verified by a cmd-133 read-back; key binds go through the cmd-3
 * keymap write (read-modify-write + verify). There is no `--yes` in the
 * web UI — every mutation is gated behind a confirm dialog
 * describing the exact change (docs/plan.md §2 read-only-by-default
 * contract adapted to a GUI). Dialogs come from ./modal.ts — no native
 * window.confirm/prompt anywhere in the UI.
 */

import { app, emit, ensureKeymap, setStatus, subscribe } from './state.ts';
import {
  MACRO_KEY_TABLE,
  MACRO_REGION_BYTES,
  MAX_STEP_DURATION,
  buildMacroRegion,
  defaultKindForName,
  macroFreeSpace,
  macroKeyValue,
  macroNameForUsage,
  macroUsageForName,
  macroSpaceNeeded,
  padMacroRegion,
  parseMacroRegion,
  parseStepsJson,
  type MacroEntry,
  type MacroStep,
} from './proto/macro916.ts';
import { KEYMAP_ENTRIES, decodeKeyValue, keyValueLabel } from './proto/khub916.ts';
import {
  formatDelay,
  macroEntryBytes,
  macroRegionUsed,
  projectRegionUsage,
  stepKeyLabel,
  stepSearchText,
  validateMacroSteps,
  type MacroIssue,
} from './macro-studio.ts';
import { confirmDialog, promptDialog } from './modal.ts';

// ── DOM helpers (same style as pages.ts) ────────────────────────────────

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

function btn(label: string, title = ''): HTMLButtonElement {
  const b = el('button', 'macro-btn', label);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label', 'macro-field');
  wrap.append(el('span', 'macro-field-label', label), input);
  return wrap;
}


/** Plain-language label for a `MACRO_KEY_TABLE` name (display only —
 *  the option value stays the vendor name so it round-trips). */
function stepKeyDisplay(name: string): string {
  const FRIENDLY: Record<string, string> = {
    ESC: 'Esc', Backquote: '`', Tab: 'Tab', CapsLock: 'Caps Lock',
    ShiftLeft: 'Left Shift', ControlLeft: 'Left Ctrl', MetaLeft: 'Left Win',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', ShiftRight: 'Right Shift',
    ControlRight: 'Right Ctrl', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Space: 'Space', Enter: 'Enter',
    Back: 'Backspace', ContextMenu: 'Menu key', Print: 'Print Screen',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'Page Up', PageDown: 'Page Down',
    ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
    ArrowUp: 'Up arrow', ArrowDown: 'Down arrow',
    ScrollLock: 'Scroll Lock', NumLock: 'Num Lock', Pause: 'Pause',
    Fn: 'Fn', counter: 'Counter',
    MouseLeft: 'Mouse left click', MouseMiddle: 'Mouse middle click',
    MouseRight: 'Mouse right click', MouseBack: 'Mouse back button',
    MouseForward: 'Mouse forward button',
  };
  const f = FRIENDLY[name];
  if (f !== undefined) return f;
  const dk = /^Key([A-Z])$/.exec(name);
  if (dk) return dk[1]!;
  const dd = /^Digit([0-9])$/.exec(name);
  if (dd) return dd[1]!;
  const np = /^Numpad(.+)$/.exec(name);
  if (np) return `Num ${np[1]}`;
  return name;
}

// ── Page ────────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  steps: MacroStep[];
}

export class MacroPage {
  readonly el: HTMLElement;
  private unsub: () => void;
  /** Index into the parsed entry list; `entries.length` = append-new. */
  private selected: number | null = null;
  private draft: Draft | null = null;
  private dirty = false;
  private busy = false;
  /** Step highlighted via the timeline / row click (null = none). */
  private selectedStep: number | null = null;
  /** Lowercase filter text for the step list (key name search). */
  private stepFilter = '';
  /** Refs to the editor sub-panels, rebuilt by renderEditor(). */
  private usageWrap: HTMLElement | null = null;
  private tlWrap: HTMLElement | null = null;
  private issuesWrap: HTMLElement | null = null;
  private stepsWrap: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    root.replaceChildren();
    this.el = el('div', 'macro-page');
    root.append(this.el);
    this.unsub = subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.unsub();
    this.el.remove();
  }

  // ── Data ────────────────────────────────────────────────────────────

  private entries(): MacroEntry[] {
    const snap = app.snapshot;
    if (!snap) return [];
    // Pad short reads to the fixed region so trailing space counts.
    const view = new Uint8Array(MACRO_REGION_BYTES);
    view.set(snap.macro.subarray(0, MACRO_REGION_BYTES));
    return parseMacroRegion(view);
  }

  private freeBytes(): number {
    const snap = app.snapshot;
    if (!snap) return 0;
    const view = new Uint8Array(MACRO_REGION_BYTES);
    view.set(snap.macro.subarray(0, MACRO_REGION_BYTES));
    return macroFreeSpace(view);
  }

  // ── Render ──────────────────────────────────────────────────────────

  private render(): void {
    this.usageWrap = this.tlWrap = this.issuesWrap = this.stepsWrap = null;
    this.el.replaceChildren();
    if (!app.connected || !app.snapshot) {
      const c = el('section', 'card');
      c.append(el('h2', '', 'Macro'));
      const body = el('div', 'card-body');
      body.append(
        el('p', 'hint', 'Press the Connect button at the top right to manage the macros saved on your keyboard.'),
      );
      c.append(body);
      this.el.append(c);
      return;
    }
    this.renderList();
    this.renderEditor();
    this.renderBind();
  }

  private renderList(): void {
    const entries = this.entries();
    const c = el('section', 'card');
    c.append(el('h2', '', `Macros (${entries.length})`));
    const body = el('div', 'card-body');
    const used = macroRegionUsed(entries);
    body.append(
      el(
        'p',
        'hint',
        `About ${this.freeBytes()} of ${MACRO_REGION_BYTES} bytes of macro storage is free ` +
          `(≈${used} of ${MACRO_REGION_BYTES} bytes used by the saved macros). ` +
          'Saving sends the whole list to the keyboard and checks it was stored correctly.',
      ),
    );

    if (entries.length === 0) {
      body.append(el('p', 'hint', 'No macros stored on the device yet.'));
    } else {
      const table = el('table', 'macro-table');
      const head = el('tr');
      for (const h of ['#', 'Name', 'Steps', '']) head.append(el('th', '', h));
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      const tbody = el('tbody');
      entries.forEach((e, i) => {
        const tr = el('tr');
        if (this.selected === i) tr.classList.add('selected');
        tr.append(
          el('td', 'mono', String(i)),
          el('td', '', e.name || '—'),
          el('td', 'mono', String(e.steps.length)),
        );
        const actions = el('td', 'macro-row-actions');
        const edit = btn(this.selected === i && this.draft ? 'Editing' : 'Edit');
        edit.disabled = this.busy;
        edit.addEventListener('click', () => this.select(i));
        const dup = btn('Copy', 'Duplicate this macro into a new unsaved entry');
        dup.disabled = this.busy;
        dup.addEventListener('click', () => this.duplicateMacro(i));
        const del = btn('Delete');
        del.disabled = this.busy;
        del.addEventListener('click', () => void this.deleteMacro(i));
        actions.append(edit, dup, del);
        tr.append(actions);
        tbody.append(tr);
      });
      table.append(tbody);
      body.append(table);
    }

    const add = btn('+ New macro');
    add.disabled = this.busy;
    add.addEventListener('click', () => this.newMacro());
    body.append(add);
    c.append(body);
    this.el.append(c);
  }

  private renderEditor(): void {
    const c = el('section', 'card');
    c.append(el('h2', '', 'Macro editor'));
    const body = el('div', 'card-body');

    if (this.selected === null || !this.draft) {
      body.append(el('p', 'hint', 'Select a macro above, or create a new one, to edit its steps.'));
      c.append(body);
      this.el.append(c);
      return;
    }

    const entries = this.entries();
    const isNew = this.selected >= entries.length;
    body.append(
      el(
        'p',
        'hint',
        `${isNew ? `New macro #${this.selected}` : `Editing macro #${this.selected}`} — ` +
          'each step is a key press or release, with a pause in milliseconds ' +
          `in between (up to ${MAX_STEP_DURATION.toLocaleString()}). ` +
          'Changes are only sent to the keyboard when you save.',
      ),
    );

    // Name row.
    const nameInput = el('input', 'macro-name') as HTMLInputElement;
    nameInput.type = 'text';
    nameInput.maxLength = 255;
    nameInput.value = this.draft.name;
    nameInput.disabled = this.busy;
    nameInput.addEventListener('input', () => {
      if (this.draft) {
        this.draft.name = nameInput.value;
        this.dirty = true;
        this.refreshLight(); // name length affects the storage estimate
      }
    });
    body.append(field('Name', nameInput));

    // Storage usage: this macro's bytes + projected region total.
    const usageWrap = el('div', 'macro-usage');
    body.append(usageWrap);
    this.usageWrap = usageWrap;
    this.renderUsage(usageWrap);

    // Timeline: one block per step, width ∝ pause, color = action.
    const tlWrap = el('div', 'macro-timeline');
    body.append(tlWrap);
    this.tlWrap = tlWrap;
    this.renderTimeline(tlWrap);

    // Validator panel — refreshed on every edit.
    const issuesWrap = el('div', 'macro-issues');
    body.append(issuesWrap);
    this.issuesWrap = issuesWrap;
    this.renderIssues(issuesWrap);

    // Step search/filter.
    const search = el('input', 'macro-search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = 'Filter steps by key name…';
    search.value = this.stepFilter;
    search.disabled = this.busy;
    search.addEventListener('input', () => {
      this.stepFilter = search.value;
      this.updateStepRowClasses();
    });
    body.append(field('Find step', search));

    // Steps table.
    const stepsWrap = el('div', 'macro-steps');
    body.append(stepsWrap);
    this.stepsWrap = stepsWrap;
    this.renderSteps(stepsWrap);

    const addStep = btn('+ Add step');
    addStep.disabled = this.busy;
    addStep.addEventListener('click', () => {
      if (!this.draft) return;
      this.draft.steps.push({ action: 0, delayMs: 0, usage: 4, kind: 'key' });
      this.dirty = true;
      this.selectedStep = this.draft.steps.length - 1;
      this.refreshEditor();
    });
    body.append(addStep);

    // JSON import (docs/macro-schema.md) — handy for porting CLI macros.
    const importBtn = btn('Import steps (JSON)…', 'Paste a steps list copied from the omg CLI — for advanced users');
    importBtn.disabled = this.busy;
    importBtn.addEventListener('click', () => {
      void promptDialog({
        title: 'Import macro steps',
        label:
          'Paste a steps list copied from the omg CLI — for advanced users. ' +
          'Accepted shapes: a [{"action":"down","key":"KeyA","delay_ms":8}, …] ' +
          'array or {"name":"…","steps":[…]} (docs/macro-schema.md).',
        multiline: true,
        placeholder: '[{"action":"down","key":"KeyA","delay_ms":8}, …]',
        confirmLabel: 'Import steps',
      }).then((text) => {
        if (text === null || text.trim() === '' || !this.draft) return;
        try {
          const parsed = parseStepsJson(text);
          this.draft.steps = parsed.steps;
          if (parsed.name !== null) this.draft.name = parsed.name;
          nameInput.value = this.draft.name;
          this.dirty = true;
          this.selectedStep = null;
          this.refreshEditor();
          setStatus(`Imported ${parsed.steps.length} step(s) — press Save to send them to the keyboard.`);
        } catch (e) {
          setStatus(`That JSON was not understood: ${e instanceof Error ? e.message : String(e)}`, true);
        }
      });
    });
    body.append(importBtn);

    // Save row.
    const saveRow = el('div', 'macro-save-row');
    const save = btn(this.dirty ? 'Save macro to keyboard' : 'Save macro (no changes)', 'Saves all macros to the keyboard');
    save.classList.add('primary');
    save.disabled = this.busy || this.draft.steps.length === 0;
    save.addEventListener('click', () => void this.saveMacro());
    const discard = btn('Discard edits');
    discard.disabled = this.busy || !this.dirty;
    discard.addEventListener('click', () => {
      if (this.selected !== null && this.selected < entries.length) {
        this.select(this.selected); // reload from device data
      } else {
        this.selected = null;
        this.draft = null;
        this.dirty = false;
        this.selectedStep = null;
        this.stepFilter = '';
        this.render();
      }
    });
    saveRow.append(save, discard);
    body.append(saveRow);

    c.append(body);
    this.el.append(c);
  }

  /** (Re)build the step rows inside `wrap` from `this.draft`. */
  private renderSteps(wrap: HTMLElement): void {
    wrap.replaceChildren();
    const draft = this.draft;
    if (!draft) return;
    const table = el('table', 'macro-table macro-steps-table');
    const head = el('tr');
    for (const h of ['#', 'Action', 'Key', 'Key type', 'Pause (ms)', '']) {
      head.append(el('th', '', h));
    }
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const tbody = el('tbody');

    draft.steps.forEach((step, i) => {
      const tr = el('tr');
      tr.dataset.stepIdx = String(i);
      tr.title = `Step ${i}: ${step.action === 0 ? 'press' : 'release'} ${stepKeyLabel(step)}, pause ${formatDelay(step.delayMs)}`;
      tr.addEventListener('click', (e) => {
        // Row click selects the step; clicks on controls keep working.
        if ((e.target as HTMLElement).closest('button, input, select')) return;
        this.selectStep(i);
      });
      tr.append(el('td', 'mono', String(i)));

      // Action: down/up (the vendor recorder's press/release).
      const action = el('select', 'macro-select') as HTMLSelectElement;
      for (const [v, label] of [
        ['0', 'Press'],
        ['1', 'Release'],
      ] as const) {
        const o = el('option', '', label);
        o.value = v;
        action.append(o);
      }
      action.value = String(step.action);
      action.disabled = this.busy;
      action.addEventListener('change', () => {
        step.action = Number(action.value);
        this.dirty = true;
        this.refreshLight();
      });
      const tdAction = el('td');
      tdAction.append(action);
      tr.append(tdAction);

      // Key: vendor `fe` name table; an unmapped/raw usage gets an extra
      // "usage N" option so the value is never silently lost.
      const keySel = el('select', 'macro-select macro-key-select') as HTMLSelectElement;
      const named = macroStepName(step);
      if (named === null) {
        const o = el('option', '', `Unknown key (code ${step.usage})`);
        o.value = `u${step.usage}`;
        keySel.append(o);
      }
      for (const [name, usage] of MACRO_KEY_TABLE) {
        // Fn/counter exceed the step's u8 code byte — not encodable.
        if (usage > 0xff) continue;
        const o = el('option', '', stepKeyDisplay(name));
        o.value = name;
        keySel.append(o);
      }
      keySel.value = named ?? `u${step.usage}`;
      keySel.disabled = this.busy;
      keySel.addEventListener('change', () => {
        const v = keySel.value;
        if (v.startsWith('u')) {
          step.usage = Number(v.slice(1));
          step.kind = 'key';
        } else {
          const usage = MACRO_KEY_TABLE.find(([n]) => n === v)?.[1];
          if (usage !== undefined && usage <= 0xff) {
            step.usage = usage;
            step.kind = defaultKindForName(v);
          }
        }
        this.syncKindSelect(kindSel, step);
        this.dirty = true;
        this.refreshLight();
      });
      const tdKey = el('td');
      tdKey.append(keySel);
      tr.append(tdKey);

      // Kind: key / modifier / mouse / raw nibble (decode fidelity).
      const kindSel = el('select', 'macro-select') as HTMLSelectElement;
      this.fillKindSelect(kindSel, step);
      kindSel.disabled = this.busy;
      kindSel.addEventListener('change', () => {
        const v = kindSel.value;
        if (v === 'key' || v === 'modifier' || v === 'mouse') {
          step.kind = v;
        }
        // 'other' keeps the raw numeric nibble already on the step.
        this.dirty = true;
        this.refreshLight();
      });
      const tdKind = el('td');
      tdKind.append(kindSel);
      tr.append(tdKind);

      // Delay.
      const delay = el('input', 'macro-delay') as HTMLInputElement;
      delay.type = 'number';
      delay.min = '0';
      delay.max = String(MAX_STEP_DURATION);
      delay.step = '1';
      delay.value = String(step.delayMs);
      delay.disabled = this.busy;
      delay.addEventListener('change', () => {
        const n = Number(delay.value);
        if (Number.isInteger(n) && n >= 0 && n <= MAX_STEP_DURATION) {
          step.delayMs = n;
          this.dirty = true;
          this.refreshLight();
        } else {
          delay.value = String(step.delayMs);
          setStatus(`Pause must be a whole number of milliseconds between 0 and ${MAX_STEP_DURATION}`, true);
        }
      });
      const tdDelay = el('td');
      tdDelay.append(delay);
      tr.append(tdDelay);

      // Row actions: reorder + remove.
      const actions = el('td', 'macro-row-actions');
      const up = btn('↑', 'Move step up');
      up.disabled = this.busy || i === 0;
      up.addEventListener('click', () => {
        draft.steps.splice(i - 1, 0, draft.steps.splice(i, 1)[0]!);
        if (this.selectedStep === i) this.selectedStep = i - 1;
        else if (this.selectedStep !== null && this.selectedStep > i) this.selectedStep -= 1;
        this.dirty = true;
        this.refreshEditor();
      });
      const downBtn = btn('↓', 'Move step down');
      downBtn.disabled = this.busy || i === draft.steps.length - 1;
      downBtn.addEventListener('click', () => {
        draft.steps.splice(i + 1, 0, draft.steps.splice(i, 1)[0]!);
        if (this.selectedStep === i) this.selectedStep = i + 1;
        else if (this.selectedStep !== null && this.selectedStep > i) this.selectedStep += 1;
        this.dirty = true;
        this.refreshEditor();
      });
      const del = btn('✕', 'Remove step');
      del.disabled = this.busy;
      del.addEventListener('click', () => {
        draft.steps.splice(i, 1);
        if (this.selectedStep === i) this.selectedStep = null;
        else if (this.selectedStep !== null && this.selectedStep > i) this.selectedStep -= 1;
        this.dirty = true;
        this.refreshEditor();
      });
      actions.append(up, downBtn, del);
      tr.append(actions);
      tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
    this.updateStepRowClasses();
  }

  // ── Studio panels: usage, timeline, issues, step filter ─────────────

  /** Re-render everything derived from the draft (steps + panels). */
  private refreshEditor(): void {
    if (this.stepsWrap) this.renderSteps(this.stepsWrap);
    this.refreshLight();
  }

  /** Re-render the panels that don't rebuild the steps table
   *  (keeps focus inside the edited control). */
  private refreshLight(): void {
    if (this.usageWrap) this.renderUsage(this.usageWrap);
    if (this.tlWrap) this.renderTimeline(this.tlWrap);
    if (this.issuesWrap) this.renderIssues(this.issuesWrap);
  }

  /** Storage line: bytes for this macro + projected region total. */
  private renderUsage(wrap: HTMLElement): void {
    wrap.replaceChildren();
    const draft = this.draft;
    if (!draft || this.selected === null) return;
    const entries = this.entries();
    const isNew = this.selected >= entries.length;
    const slot = isNew ? entries.length : this.selected;
    const proj = projectRegionUsage(
      entries,
      slot,
      { name: draft.name, steps: draft.steps },
    );

    let ownBytes = '—';
    try {
      ownBytes = String(macroEntryBytes({ name: draft.name, steps: draft.steps }));
    } catch {
      ownBytes = `over ${MACRO_REGION_BYTES}`;
    }
    const line = el(
      'p',
      `hint macro-usage-line${proj.fits ? '' : ' warn'}`,
      `Storage: this macro uses ≈${ownBytes} bytes · all macros together ≈${proj.usedBytes} of ${proj.capacityBytes} bytes.`,
    );
    wrap.append(line);
    if (!proj.fits && proj.problem) {
      wrap.append(el('p', 'hint warn', proj.problem));
    }
  }

  /**
   * Horizontal timeline: one block per step. Block width is
   * proportional to the step's pause (flex-grow = delayMs, floored so
   * zero-delay steps stay visible); colour = press (lime) / release
   * (muted) / mouse (accent-blue). Click selects the step.
   */
  private renderTimeline(wrap: HTMLElement): void {
    wrap.replaceChildren();
    const draft = this.draft;
    if (!draft || draft.steps.length === 0) {
      wrap.append(el('p', 'hint', 'No steps yet — add a step to see the timeline.'));
      return;
    }
    const legend = el('div', 'macro-tl-legend');
    for (const [cls, label] of [
      ['down', 'Press'],
      ['up', 'Release'],
      ['mouse', 'Mouse'],
    ] as const) {
      const item = el('span', 'macro-tl-legend-item');
      item.append(el('span', `macro-tl-swatch ${cls}`), document.createTextNode(label));
      legend.append(item);
    }
    wrap.append(legend);

    const track = el('div', 'macro-tl-track');
    track.setAttribute('role', 'list');
    draft.steps.forEach((step, i) => {
      const kind = step.kind === 'mouse' ? 'mouse' : step.action === 0 ? 'down' : 'up';
      const b = el('button', `macro-tl-block ${kind}`) as HTMLButtonElement;
      b.type = 'button';
      // Width ∝ pause: grow by delayMs, with a readable minimum via CSS.
      b.style.flexGrow = String(Math.max(step.delayMs, 1));
      b.style.flexBasis = '0';
      if (this.selectedStep === i) b.classList.add('selected');
      const label = stepKeyLabel(step);
      b.title = `Step ${i}: ${step.action === 0 ? 'press' : 'release'} ${label} — pause ${formatDelay(step.delayMs)} (click to edit)`;
      b.textContent = `${i} ${label}`;
      b.setAttribute('role', 'listitem');
      b.addEventListener('click', () => this.selectStep(i));
      track.append(b);
    });
    wrap.append(track);
    wrap.append(
      el('p', 'hint', 'Each block is one step — wider means a longer pause. Click a block to jump to that step.'),
    );
  }

  /** Validator panel: issues from validateMacroSteps + storage fit. */
  private renderIssues(wrap: HTMLElement): void {
    wrap.replaceChildren();
    const draft = this.draft;
    if (!draft || this.selected === null) return;

    const issues: MacroIssue[] = validateMacroSteps(draft.steps);
    // Storage projection adds a whole-macro error when it can't fit.
    const entries = this.entries();
    const isNew = this.selected >= entries.length;
    const proj = projectRegionUsage(
      entries,
      isNew ? entries.length : this.selected,
      { name: draft.name, steps: draft.steps },
    );
    if (!proj.fits && proj.problem) {
      issues.unshift({ level: 'error', step: null, message: proj.problem });
    }

    if (issues.length === 0) {
      wrap.append(
        el('p', 'hint macro-issues-ok', `✓ ${draft.steps.length} step(s) checked — no problems found.`),
      );
      return;
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    wrap.append(
      el(
        'p',
        'hint',
        `${issues.length} thing${issues.length === 1 ? '' : 's'} to check` +
          (errors > 0 ? ` (${errors} will likely fail or misbehave)` : '') +
          ' — click one to jump to its step:',
      ),
    );
    const list = el('ul', 'macro-issue-list');
    for (const issue of issues) {
      const li = el('li', `macro-issue ${issue.level}`);
      li.textContent = issue.message;
      if (issue.step !== null) {
        li.classList.add('clickable');
        li.title = 'Jump to this step';
        li.addEventListener('click', () => this.selectStep(issue.step!));
      }
      list.append(li);
    }
    wrap.append(list);
  }

  /** Highlight/dim step rows from selectedStep + stepFilter. */
  private updateStepRowClasses(): void {
    const wrap = this.stepsWrap;
    const draft = this.draft;
    if (!wrap || !draft) return;
    const filter = this.stepFilter.trim().toLowerCase();
    for (const tr of wrap.querySelectorAll<HTMLElement>('tr[data-step-idx]')) {
      const idx = Number(tr.dataset.stepIdx);
      const step = draft.steps[idx];
      tr.classList.toggle('step-selected', this.selectedStep === idx);
      const match =
        filter === '' || (step !== undefined && stepSearchText(step).includes(filter));
      tr.classList.toggle('step-dim', filter !== '' && !match);
      tr.classList.toggle('step-match', filter !== '' && match);
    }
  }

  /** Select a step (timeline block / row / issue click) and reveal it. */
  private selectStep(i: number): void {
    if (!this.draft || i < 0 || i >= this.draft.steps.length) return;
    this.selectedStep = i;
    this.refreshLight();
    this.updateStepRowClasses();
    const row = this.stepsWrap?.querySelector<HTMLElement>(`tr[data-step-idx="${i}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }

  private fillKindSelect(sel: HTMLSelectElement, step: MacroStep): void {
    sel.replaceChildren();
    const opts: [string, string][] = [
      ['key', 'Key'],
      ['modifier', 'Modifier'],
      ['mouse', 'Mouse'],
    ];
    if (typeof step.kind === 'number') {
      opts.push(['other', 'Other (advanced)']);
    }
    for (const [v, label] of opts) {
      const o = el('option', '', label);
      o.value = v;
      sel.append(o);
    }
    sel.value = typeof step.kind === 'number' ? 'other' : step.kind;
  }

  /** Keep the kind select in sync after the key changes (named keys only). */
  private syncKindSelect(sel: HTMLSelectElement, step: MacroStep): void {
    if (typeof step.kind === 'number') return; // raw nibble preserved
    this.fillKindSelect(sel, step);
  }

  private renderBind(): void {
    const entries = this.entries();
    const c = el('section', 'card');
    c.append(el('h2', '', 'Bind to a key'));
    const body = el('div', 'card-body');
    body.append(
      el(
        'p',
        'hint',
        'Runs a saved macro when you press one key on a chosen key set. ' +
          'The macro must be saved on the keyboard first.',
      ),
    );
    if (entries.length === 0) {
      body.append(el('p', 'hint', 'No macros stored — save one first.'));
      c.append(body);
      this.el.append(c);
      return;
    }

    const row = el('div', 'macro-bind-row');

    const macroSel = el('select', 'macro-select') as HTMLSelectElement;
    entries.forEach((e, i) => {
      const o = el('option', '', `[${i}] ${e.name || '(unnamed)'} — ${e.steps.length} steps`);
      o.value = String(i);
      macroSel.append(o);
    });
    // Default to the macro being edited, when it exists on the device.
    if (this.selected !== null && this.selected < entries.length) {
      macroSel.value = String(this.selected);
    }
    row.append(field('Macro', macroSel));

    const slotInput = el('input', 'macro-num') as HTMLInputElement;
    slotInput.type = 'number';
    slotInput.min = '0';
    slotInput.max = String(KEYMAP_ENTRIES - 1);
    slotInput.value = '0';
    slotInput.placeholder = '0–127';
    row.append(field('Key position', slotInput));

    const layerSel = el('select', 'macro-select') as HTMLSelectElement;
    for (let l = 0; l < 4; l++) {
      const o = el('option', '', `Key set ${l + 1}`);
      o.value = String(l);
      layerSel.append(o);
    }
    layerSel.value = String(app.layer);
    row.append(field('Key set', layerSel));
    body.append(row);

    // Rarely needed — the defaults (type 1, loop 1) cover normal macros.
    const adv = el('details', 'advanced');
    adv.append(el('summary', '', 'Advanced'));
    const advBody = el('div', 'advanced-body');
    const advRow = el('div', 'macro-bind-row');

    const typeInput = el('input', 'macro-num') as HTMLInputElement;
    typeInput.type = 'number';
    typeInput.min = '1';
    typeInput.max = '255';
    typeInput.value = '1';
    advRow.append(field('Macro type', typeInput));

    const loopInput = el('input', 'macro-num') as HTMLInputElement;
    loopInput.type = 'number';
    loopInput.min = '1';
    loopInput.max = '255';
    loopInput.value = '1';
    advRow.append(field('Repeat count', loopInput));
    advBody.append(advRow);
    adv.append(advBody);
    body.append(adv);

    const btnRow = el('div', 'macro-save-row');
    const bind = btn('Assign macro to key');
    bind.classList.add('primary');
    bind.disabled = this.busy;
    bind.addEventListener('click', () => void this.bind(macroSel, slotInput, layerSel, typeInput, loopInput, false));
    const unbind = btn('Clear this key');
    unbind.disabled = this.busy;
    unbind.addEventListener('click', () => void this.bind(macroSel, slotInput, layerSel, typeInput, loopInput, true));
    btnRow.append(bind, unbind);
    body.append(btnRow);
    body.append(
      el('p', 'hint', 'Type the key position (0–127). On the Keys page, click a key to see its position.'),
    );

    c.append(body);
    this.el.append(c);
  }

  // ── Actions ─────────────────────────────────────────────────────────

  private select(i: number): void {
    const entries = this.entries();
    if (i < 0 || i >= entries.length) return;
    this.selected = i;
    const e = entries[i]!;
    this.draft = {
      name: e.name,
      steps: e.steps.map((s) => ({ ...s })),
    };
    this.dirty = false;
    this.selectedStep = null;
    this.stepFilter = '';
    this.render();
  }

  private newMacro(): void {
    const n = this.entries().length;
    this.selected = n;
    this.draft = { name: `macro${n}`, steps: [] };
    this.dirty = true;
    this.selectedStep = null;
    this.stepFilter = '';
    this.render();
  }

  /**
   * Duplicate a stored macro into a new unsaved draft (appended slot).
   * Nothing is written until Save — the normal storage pre-check and
   * confirm dialog still apply.
   */
  private duplicateMacro(i: number): void {
    if (this.busy) return;
    const entries = this.entries();
    const e = entries[i];
    if (!e) return;
    // "<name> copy", kept within the 255-byte name limit.
    let name = `${e.name || 'macro'} copy`;
    while (new TextEncoder().encode(name).length > 255) {
      name = name.slice(0, -1);
    }
    this.selected = entries.length;
    this.draft = {
      name,
      steps: e.steps.map((s) => ({ ...s })),
    };
    this.dirty = true;
    this.selectedStep = null;
    this.stepFilter = '';
    this.render();
    setStatus(`Duplicated "${e.name || '(unnamed)'}" as a new macro — edit it, then Save to send it to the keyboard.`);
  }

  /** Rebuild the full entry list with the draft applied, then write. */
  private async saveMacro(): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot || this.selected === null || !this.draft) return;
    const draft = this.draft;
    if (draft.steps.length === 0) {
      setStatus('A macro needs at least one step. To remove a macro, use Delete instead.', true);
      return;
    }
    const entries = this.entries();
    const isNew = this.selected >= entries.length;
    const slot = isNew ? entries.length : this.selected;

    // Vendor space pre-check for appends (MacroConfiguration `ae()`).
    if (isNew) {
      const needed = macroSpaceNeeded(draft.name, draft.steps.length);
      const free = this.freeBytes();
      if (needed > free) {
        setStatus(
          `Not enough macro storage: '${draft.name}' needs about ${needed} bytes but only about ${free} are free — delete unused macros first.`,
          true,
        );
        return;
      }
    }

    const next: MacroEntry[] = entries.map((e) => ({ name: e.name, steps: e.steps.map((s) => ({ ...s })) }));
    const entry: MacroEntry = { name: draft.name, steps: draft.steps.map((s) => ({ ...s })) };
    if (isNew) next.push(entry);
    else next[slot] = entry;

    let region: Uint8Array;
    try {
      region = buildMacroRegion(next);
    } catch (e) {
      setStatus(`Could not prepare the macro data: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }

    const desc = isNew
      ? `Create new macro "${entry.name}" with ${entry.steps.length} step(s)`
      : `Replace macro "${entries[slot]?.name ?? ''}" with "${entry.name}" (${entry.steps.length} step(s))`;
    const ok = await confirmDialog({
      title: 'Save macros to the keyboard?',
      bodyText: `${desc}.\n\nThis overwrites the whole macro list stored on the keyboard with the list shown on this page — including any macros you have not opened. Keys and lighting are not touched.`,
      hint: 'You can save a full backup of the keyboard first on the Backup & restore page.',
      confirmLabel: 'Save to keyboard',
    });
    if (!ok) return;

    this.busy = true;
    this.render();
    try {
      await app.connected.session.writeMacroRegion(region);
      // Verified — store the padded region we sent (read-back matched).
      app.snapshot.macro = padMacroRegion(region);
      this.dirty = false;
      this.selected = slot;
      setStatus(`${desc} — saved and checked on the keyboard.`);
      emit();
    } catch (e) {
      setStatus(`Could not save the macro: ${e instanceof Error ? e.message : String(e)}`, true);
      // Re-read in case the write partially landed.
      try {
        app.snapshot.macro = await app.connected.session.macroRegion();
        emit();
      } catch {
        /* keep stale snapshot */
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async deleteMacro(i: number): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot) return;
    const entries = this.entries();
    const e = entries[i];
    if (!e) return;
    const next = entries
      .filter((_, j) => j !== i)
      .map((x) => ({ name: x.name, steps: x.steps.map((s) => ({ ...s })) }));
    // Empty region: send a minimal 4-byte all-zero table (parses as
    // "no macros") — mirrors `Kb916Macro::Delete` in the CLI.
    let region: Uint8Array;
    try {
      region = next.length === 0 ? new Uint8Array(4) : buildMacroRegion(next);
    } catch (err) {
      setStatus(`Could not prepare the macro data: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete macro "${e.name}"?`,
      bodyText:
        `This removes "${e.name}" (${e.steps.length} step(s)) from the keyboard — ` +
        'the whole macro list is rewritten without it. Keys already assigned to ' +
        'this macro will stop working. Your other macros are not affected.',
      hint: 'You can save a full backup of the keyboard first on the Backup & restore page.',
      confirmLabel: 'Delete macro',
      danger: true,
    });
    if (!ok) return;
    this.busy = true;
    this.render();
    try {
      await app.connected.session.writeMacroRegion(region);
      app.snapshot.macro = padMacroRegion(region);
      if (this.selected === i) {
        this.selected = null;
        this.draft = null;
        this.dirty = false;
        this.selectedStep = null;
        this.stepFilter = '';
      } else if (this.selected !== null && this.selected > i) {
        this.selected -= 1;
      }
      if (this.selectedStep !== null && this.draft && this.selectedStep >= this.draft.steps.length) {
        this.selectedStep = null;
      }
      setStatus(`Deleted macro "${e.name}" — saved and checked on the keyboard.`);
      emit();
    } catch (err) {
      setStatus(`Could not delete the macro: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** Tag-3 keymap slot write (bind or unbind), read-modify-write + verify. */
  private async bind(
    macroSel: HTMLSelectElement,
    slotInput: HTMLInputElement,
    layerSel: HTMLSelectElement,
    typeInput: HTMLInputElement,
    loopInput: HTMLInputElement,
    unbind: boolean,
  ): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot) return;
    const slot = Number(slotInput.value);
    const layer = Number(layerSel.value);
    if (!Number.isInteger(slot) || slot < 0 || slot >= KEYMAP_ENTRIES) {
      setStatus(`Key position must be a whole number between 0 and ${KEYMAP_ENTRIES - 1}`, true);
      return;
    }
    const arg = (layer & 3); // system bit stays 0 in this UI
    const index = unbind ? 0 : Number(macroSel.value);
    const macroType = unbind ? 1 : Number(typeInput.value);
    const loopCount = unbind ? 1 : Number(loopInput.value);
    if (!unbind) {
      if (!Number.isInteger(macroType) || macroType < 1 || macroType > 255) {
        setStatus('Type must be a whole number between 1 and 255', true);
        return;
      }
      if (!Number.isInteger(loopCount) || loopCount < 1 || loopCount > 255) {
        setStatus('Repeat count must be a whole number of at least 1', true);
        return;
      }
    }
    const value = unbind ? 0 : macroKeyValue(macroType, loopCount, index);

    const oldLabel = async (): Promise<string> => {
      const cached = app.snapshot?.keymaps.get(arg);
      const kv = cached?.[slot]?.label ?? (await this.slotLabel(arg, slot));
      return kv || 'empty';
    };

    const before = await oldLabel().catch(() => 'unknown');
    const macroName = unbind ? '' : (this.entries()[index]?.name ?? `#${index}`);
    const desc = unbind
      ? `Clear key ${slot} on key set ${layer + 1} (currently ${before})`
      : `Assign macro "${macroName}" to key ${slot} on key set ${layer + 1} (currently ${before})`;
    const ok = await confirmDialog({
      title: 'Save this key change?',
      bodyText: `${desc}.\n\nThis writes the new key assignment to the keyboard — nothing else changes. The keyboard checks the change was saved.`,
      confirmLabel: 'Save to keyboard',
    });
    if (!ok) return;

    this.busy = true;
    this.render();
    try {
      const values = await app.connected.session.keyValues(arg);
      if (slot >= values.length) {
        throw new Error(`key ${slot} is out of range — the keyboard only has ${values.length} key positions`);
      }
      const nextVals = values.slice();
      while (nextVals.length < KEYMAP_ENTRIES) nextVals.push(0);
      nextVals[slot] = value;
      await app.connected.session.writeKeymap(layer, 0, nextVals);
      // Refresh the cached decode for this arg.
      app.snapshot.keymaps.delete(arg);
      void ensureKeymap(arg).catch(() => {});
      setStatus(
        unbind
          ? `Key ${slot} cleared — checked on the keyboard.`
          : `Key ${slot} now runs macro "${macroName}" — checked on the keyboard.`,
      );
      emit();
    } catch (e) {
      setStatus(`Could not save the key change: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async slotLabel(arg: number, slot: number): Promise<string> {
    if (!app.connected) return '';
    const values = await app.connected.session.keyValues(arg);
    const v = values[slot];
    return v === undefined ? '' : keyValueLabel(decodeKeyValue(v));
  }
}

/** Display name for a decoded step's usage byte (vendor `fe` lookup). */
function macroStepName(step: MacroStep): string | null {
  const name = macroNameForUsage(step.usage, step.kind);
  // Only offer the name as a select option when it round-trips: usage
  // must fit the u8 code byte (Fn/counter exceed it).
  return name !== null && macroUsageForName(name) === step.usage ? name : null;
}
