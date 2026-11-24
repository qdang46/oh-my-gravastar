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
 * web UI — every mutation is gated behind a `window.confirm` dialog
 * describing the exact change (docs/plan.md §2 read-only-by-default
 * contract adapted to a GUI).
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
import { t } from './i18n.ts';

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
    this.el.replaceChildren();
    if (!app.connected || !app.snapshot) {
      const c = el('section', 'card');
      c.append(el('h2', '', t('macro.title')));
      const body = el('div', 'card-body');
      body.append(
        el('p', 'hint', t('macro.connectBlurb')),
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
    c.append(el('h2', '', t('macro.count', { n: entries.length })));
    const body = el('div', 'card-body');
    body.append(
      el(
        'p',
        'hint',
        t('macro.storageHint', { free: this.freeBytes(), total: MACRO_REGION_BYTES }),
      ),
    );

    if (entries.length === 0) {
      body.append(el('p', 'hint', t('macro.empty')));
    } else {
      const table = el('table', 'macro-table');
      const head = el('tr');
      for (const h of ['#', t('macro.colName'), t('macro.colSteps'), '']) head.append(el('th', '', h));
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
        const edit = btn(this.selected === i && this.draft ? t('macro.editing') : t('macro.edit'));
        edit.disabled = this.busy;
        edit.addEventListener('click', () => this.select(i));
        const del = btn(t('macro.delete'));
        del.disabled = this.busy;
        del.addEventListener('click', () => void this.deleteMacro(i));
        actions.append(edit, del);
        tr.append(actions);
        tbody.append(tr);
      });
      table.append(tbody);
      body.append(table);
    }

    const add = btn(t('macro.new'));
    add.disabled = this.busy;
    add.addEventListener('click', () => this.newMacro());
    body.append(add);
    c.append(body);
    this.el.append(c);
  }

  private renderEditor(): void {
    const c = el('section', 'card');
    c.append(el('h2', '', t('macro.editor')));
    const body = el('div', 'card-body');

    if (this.selected === null || !this.draft) {
      body.append(el('p', 'hint', t('macro.editorEmpty')));
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
        `${isNew ? t('macro.newN', { n: this.selected }) : t('macro.editingN', { n: this.selected })} — ` +
          t('macro.editorHint', { max: MAX_STEP_DURATION.toLocaleString() }),
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
      }
    });
    body.append(field(t('macro.name'), nameInput));

    // Steps table.
    const stepsWrap = el('div', 'macro-steps');
    body.append(stepsWrap);
    this.renderSteps(stepsWrap);

    const addStep = btn(t('macro.newStep'));
    addStep.disabled = this.busy;
    addStep.addEventListener('click', () => {
      if (!this.draft) return;
      this.draft.steps.push({ action: 0, delayMs: 0, usage: 4, kind: 'key' });
      this.dirty = true;
      this.renderSteps(stepsWrap);
    });
    body.append(addStep);

    // JSON import (docs/macro-schema.md) — handy for porting CLI macros.
    const importBtn = btn(t('macro.importJson'));
    importBtn.disabled = this.busy;
    importBtn.addEventListener('click', () => {
      const text = window.prompt(t('macro.importPrompt'));
      if (text === null || !this.draft) return;
      try {
        const parsed = parseStepsJson(text);
        this.draft.steps = parsed.steps;
        if (parsed.name !== null) this.draft.name = parsed.name;
        nameInput.value = this.draft.name;
        this.dirty = true;
        this.renderSteps(stepsWrap);
        setStatus(t('macro.imported', { n: parsed.steps.length }));
      } catch (e) {
        setStatus(t('macro.importFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      }
    });
    body.append(importBtn);

    // Save row.
    const saveRow = el('div', 'macro-save-row');
    const save = btn(this.dirty ? t('macro.saveBtn') : t('macro.saveBtnClean'), t('macro.saveHint'));
    save.classList.add('primary');
    save.disabled = this.busy || this.draft.steps.length === 0;
    save.addEventListener('click', () => void this.saveMacro());
    const discard = btn(t('macro.discard'));
    discard.disabled = this.busy || !this.dirty;
    discard.addEventListener('click', () => {
      if (this.selected !== null && this.selected < entries.length) {
        this.select(this.selected); // reload from device data
      } else {
        this.selected = null;
        this.draft = null;
        this.dirty = false;
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
    for (const h of ['#', t('macro.colAction'), t('common.key'), t('macro.colKind'), t('macro.colDelay'), '']) {
      head.append(el('th', '', h));
    }
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const tbody = el('tbody');

    draft.steps.forEach((step, i) => {
      const tr = el('tr');
      tr.append(el('td', 'mono', String(i)));

      // Action: down/up (the vendor recorder's press/release).
      const action = el('select', 'macro-select') as HTMLSelectElement;
      for (const [v, label] of [
        ['0', t('macro.press')],
        ['1', t('macro.release')],
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
      });
      const tdAction = el('td');
      tdAction.append(action);
      tr.append(tdAction);

      // Key: vendor `fe` name table; an unmapped/raw usage gets an extra
      // "usage N" option so the value is never silently lost.
      const keySel = el('select', 'macro-select macro-key-select') as HTMLSelectElement;
      const named = macroStepName(step);
      if (named === null) {
        const o = el('option', '', t('macro.unknownKey', { u: step.usage }));
        o.value = `u${step.usage}`;
        keySel.append(o);
      }
      for (const [name, usage] of MACRO_KEY_TABLE) {
        // Fn/counter exceed the step's u8 code byte — not encodable.
        if (usage > 0xff) continue;
        const o = el('option', '', name);
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
        } else {
          delay.value = String(step.delayMs);
          setStatus(t('macro.badDelay', { max: MAX_STEP_DURATION }), true);
        }
      });
      const tdDelay = el('td');
      tdDelay.append(delay);
      tr.append(tdDelay);

      // Row actions: reorder + remove.
      const actions = el('td', 'macro-row-actions');
      const up = btn('↑', t('macro.moveUp'));
      up.disabled = this.busy || i === 0;
      up.addEventListener('click', () => {
        draft.steps.splice(i - 1, 0, draft.steps.splice(i, 1)[0]!);
        this.dirty = true;
        this.renderSteps(wrap);
      });
      const downBtn = btn('↓', t('macro.moveDown'));
      downBtn.disabled = this.busy || i === draft.steps.length - 1;
      downBtn.addEventListener('click', () => {
        draft.steps.splice(i + 1, 0, draft.steps.splice(i, 1)[0]!);
        this.dirty = true;
        this.renderSteps(wrap);
      });
      const del = btn('✕', t('macro.removeStep'));
      del.disabled = this.busy;
      del.addEventListener('click', () => {
        draft.steps.splice(i, 1);
        this.dirty = true;
        this.renderSteps(wrap);
      });
      actions.append(up, downBtn, del);
      tr.append(actions);
      tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
  }

  private fillKindSelect(sel: HTMLSelectElement, step: MacroStep): void {
    sel.replaceChildren();
    const opts: [string, string][] = [
      ['key', t('macro.kindKey')],
      ['modifier', t('macro.kindModifier')],
      ['mouse', t('macro.kindMouse')],
    ];
    if (typeof step.kind === 'number') {
      opts.push(['other', t('macro.kindOther')]);
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
    c.append(el('h2', '', t('macro.bindTitle')));
    const body = el('div', 'card-body');
    body.append(el('p', 'hint', t('macro.bindHint')));
    if (entries.length === 0) {
      body.append(el('p', 'hint', t('macro.bindEmpty')));
      c.append(body);
      this.el.append(c);
      return;
    }

    const row = el('div', 'macro-bind-row');

    const macroSel = el('select', 'macro-select') as HTMLSelectElement;
    entries.forEach((e, i) => {
      const o = el('option', '', `[${i}] ${e.name || t('macro.unnamedEntry')} — ${t('macro.stepsCount', { n: e.steps.length })}`);
      o.value = String(i);
      macroSel.append(o);
    });
    // Default to the macro being edited, when it exists on the device.
    if (this.selected !== null && this.selected < entries.length) {
      macroSel.value = String(this.selected);
    }
    row.append(field(t('macro.macroSel'), macroSel));

    const slotInput = el('input', 'macro-num') as HTMLInputElement;
    slotInput.type = 'number';
    slotInput.min = '0';
    slotInput.max = String(KEYMAP_ENTRIES - 1);
    slotInput.value = '0';
    slotInput.placeholder = '0–127';
    row.append(field(t('common.keySlot'), slotInput));

    const layerSel = el('select', 'macro-select') as HTMLSelectElement;
    for (let l = 0; l < 4; l++) {
      const o = el('option', '', t('common.layer', { n: l }));
      o.value = String(l);
      layerSel.append(o);
    }
    layerSel.value = String(app.layer);
    row.append(field(t('macro.layer'), layerSel));
    body.append(row);

    // Rarely needed — the defaults (type 1, loop 1) cover normal macros.
    const adv = el('details', 'advanced');
    adv.append(el('summary', '', t('macro.advanced')));
    const advBody = el('div', 'advanced-body');
    const advRow = el('div', 'macro-bind-row');

    const typeInput = el('input', 'macro-num') as HTMLInputElement;
    typeInput.type = 'number';
    typeInput.min = '1';
    typeInput.max = '255';
    typeInput.value = '1';
    advRow.append(field(t('macro.macroType'), typeInput));

    const loopInput = el('input', 'macro-num') as HTMLInputElement;
    loopInput.type = 'number';
    loopInput.min = '1';
    loopInput.max = '255';
    loopInput.value = '1';
    advRow.append(field(t('macro.loopCount'), loopInput));
    advBody.append(advRow);
    adv.append(advBody);
    body.append(adv);

    const btnRow = el('div', 'macro-save-row');
    const bind = btn(t('macro.assign'));
    bind.classList.add('primary');
    bind.disabled = this.busy;
    bind.addEventListener('click', () => void this.bind(macroSel, slotInput, layerSel, typeInput, loopInput, false));
    const unbind = btn(t('macro.clearKey'));
    unbind.disabled = this.busy;
    unbind.addEventListener('click', () => void this.bind(macroSel, slotInput, layerSel, typeInput, loopInput, true));
    btnRow.append(bind, unbind);
    body.append(btnRow);
    body.append(el('p', 'hint', t('macro.slotHint')));

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
    this.render();
  }

  private newMacro(): void {
    const n = this.entries().length;
    this.selected = n;
    this.draft = { name: `macro${n}`, steps: [] };
    this.dirty = true;
    this.render();
  }

  /** Rebuild the full entry list with the draft applied, then write. */
  private async saveMacro(): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot || this.selected === null || !this.draft) return;
    const draft = this.draft;
    if (draft.steps.length === 0) {
      setStatus(t('macro.needsStep'), true);
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
          t('macro.noSpace', { name: draft.name, need: needed, free }),
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
      setStatus(t('macro.prepareFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      return;
    }

    const desc = isNew
      ? t('macro.createDesc', { name: entry.name, n: entry.steps.length })
      : t('macro.replaceDesc', { old: entries[slot]?.name ?? '', name: entry.name, n: entry.steps.length });
    if (!window.confirm(`${desc}\n\n${t('macro.saveAllQ')}`)) {
      return;
    }

    this.busy = true;
    this.render();
    try {
      await app.connected.session.writeMacroRegion(region);
      // Verified — store the padded region we sent (read-back matched).
      app.snapshot.macro = padMacroRegion(region);
      this.dirty = false;
      this.selected = slot;
      setStatus(t('macro.savedOk', { desc }));
      emit();
    } catch (e) {
      setStatus(t('macro.saveFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
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
      setStatus(t('macro.prepareFailed', { msg: err instanceof Error ? err.message : String(err) }), true);
      return;
    }
    if (
      !window.confirm(t('macro.deleteQ', { name: e.name, n: e.steps.length }))
    ) {
      return;
    }
    this.busy = true;
    this.render();
    try {
      await app.connected.session.writeMacroRegion(region);
      app.snapshot.macro = padMacroRegion(region);
      if (this.selected === i) {
        this.selected = null;
        this.draft = null;
        this.dirty = false;
      } else if (this.selected !== null && this.selected > i) {
        this.selected -= 1;
      }
      setStatus(t('macro.deleted', { name: e.name }));
      emit();
    } catch (err) {
      setStatus(t('macro.deleteFailed', { msg: err instanceof Error ? err.message : String(err) }), true);
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
      setStatus(t('macro.badSlot', { max: KEYMAP_ENTRIES - 1 }), true);
      return;
    }
    const arg = (layer & 3); // system bit stays 0 in this UI
    const index = unbind ? 0 : Number(macroSel.value);
    const macroType = unbind ? 1 : Number(typeInput.value);
    const loopCount = unbind ? 1 : Number(loopInput.value);
    if (!unbind) {
      if (!Number.isInteger(macroType) || macroType < 1 || macroType > 255) {
        setStatus(t('macro.badType'), true);
        return;
      }
      if (!Number.isInteger(loopCount) || loopCount < 1 || loopCount > 255) {
        setStatus(t('macro.badLoop'), true);
        return;
      }
    }
    const value = unbind ? 0 : macroKeyValue(macroType, loopCount, index);

    const oldLabel = async (): Promise<string> => {
      const cached = app.snapshot?.keymaps.get(arg);
      const kv = cached?.[slot]?.label ?? (await this.slotLabel(arg, slot));
      return kv || t('common.empty');
    };

    const before = await oldLabel().catch(() => t('common.unknown'));
    const desc = unbind
      ? t('macro.clearDesc', { slot, layer, before })
      : t('macro.assignDesc', { i: index, slot, layer, before });
    if (!window.confirm(`${desc}\n\n${t('macro.saveChangeQ')}`)) return;

    this.busy = true;
    this.render();
    try {
      const values = await app.connected.session.keyValues(arg);
      if (slot >= values.length) {
        throw new Error(t('macro.slotRange', { slot, n: values.length }));
      }
      const nextVals = values.slice();
      while (nextVals.length < KEYMAP_ENTRIES) nextVals.push(0);
      nextVals[slot] = value;
      await app.connected.session.writeKeymap(layer, 0, nextVals);
      // Refresh the cached decode for this arg.
      app.snapshot.keymaps.delete(arg);
      void ensureKeymap(arg).catch(() => {});
      const macroName = unbind ? '' : (this.entries()[index]?.name ?? `#${index}`);
      setStatus(
        unbind
          ? t('macro.slotCleared', { slot })
          : t('macro.slotRuns', { slot, name: macroName }),
      );
      emit();
    } catch (e) {
      setStatus(t('macro.keySaveFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
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
