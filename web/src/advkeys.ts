/**
 * Advanced keys page — clone of the vendor `AdvancedKey` page
 * (`docs/research/khub-webapp/AdvancedKey-YMbKTFT4.js`): SOCD, MT
 * (mod-tap / hold-tap) and TGL trigger management for khub916 keyboards.
 *
 * Mirrors `omg kb916 adv list|set` (`crates/omg/src/kb916_adv.rs`) and
 * the codec port in `proto/advkey916.ts` (Rust `advkey.rs`):
 *
 * - an adv key = a keymap binding (`0x20/0x21/0x22 SS …` u32 on the
 *   arg-0 keymap) + a 512-byte history blob entry (cmd 146 read /
 *   cmd 18 write);
 * - `set` performs the vendor's two writes in order — keymap first
 *   (cmd 3 `sendKeyConfiguration` header, tags 0/2, read-back
 *   verified), then the history blob (cmd 18, best-effort verify);
 * - there is **no delete** — the vendor UI's delete only edits a
 *   localStorage cache. "Unbind" here overwrites the keymap slot with
 *   0 via the normal cmd-3 keymap write (same as
 *   `omg kb916 set key <i> 0`); the history slot stays allocated.
 *
 * Honesty contract (docs/advkeys-schema.md): on K1 Pro the cmd-18
 * history write does NOT persist and cmd-146 read-back is unstable
 * for ~60 s — the session reports `verified: false`, and this page
 * shows "sent, not confirmed" rather than faking success. The
 * keymap binding half *is* live-verified.
 */

import { app, emit, ensureKeymap, setStatus, subscribe } from './state.ts';
import {
  ADV_BLOB_BYTES,
  KIND_LABEL,
  advHex8,
  bindingPayload,
  historyEntries,
  normalizeBlob,
  planMt,
  planSocd,
  planTgl,
  scanAdvBindings,
  valueLabel,
  type AdvBinding,
  type AdvKind,
  type AdvPlan,
} from './proto/advkey916.ts';
import { decodeKeyValue, keyValueLabel, KEYMAP_ENTRIES } from './proto/khub916.ts';
import { KEY_POOL, POOL_UNASSIGN, type PoolEntry } from './keypool.ts';
import { t } from './i18n.ts';

// ── DOM helpers (same style as macro.ts) ───────────────────────────────

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

// ── Display helpers ────────────────────────────────────────────────────

function hex8(v: number): string {
  return advHex8(v);
}

/**
 * Cell text for a stored key value — label only. The keymap decoder
 * falls back to `0x…` for unnamed values; raw hex goes to the cell's
 * `title` tooltip instead (same pattern as remap.ts).
 */
function valueText(v: number): string {
  const label = valueLabel(v);
  return label !== '' && !label.startsWith('0x') ? label : t('adv.customValue');
}

/** `title` tooltip carrying the raw hex for a list of values. */
function valuesTitle(values: readonly number[]): string {
  return values.map((v) => hex8(v)).join(', ');
}

/** Human-readable detail for one binding's low bits. */
function detailText(b: AdvBinding): string {
  const d = b.detail;
  if (d.kind === 'socd') {
    const dirs = [t('adv.dirLast'), t('adv.dirA'), t('adv.dirB'), t('adv.dirAll')];
    return `${dirs[d.direction] ?? `mode ${d.direction}`}${d.keyB ? ` · ${t('adv.involvesB')}` : ` · ${t('adv.involvesA')}`}`;
  }
  if (d.kind === 'mt') return t('adv.holdAfter', { ms: d.time * 10 })
  return t('adv.toggle');
}

const SOCD_DIRECTIONS: readonly { id: number; labelKey: string }[] = [
  { id: 0, labelKey: 'adv.socdLastWins' },
  { id: 1, labelKey: 'adv.socdAPriority' },
  { id: 2, labelKey: 'adv.socdBPriority' },
  { id: 3, labelKey: 'adv.socdAllCancel' },
];

// ── Page ───────────────────────────────────────────────────────────────

export class AdvPage {
  readonly el: HTMLElement;
  private unsub: () => void;
  private busy = false;
  /** Normalized 512-byte history blob (cmd 146), null until read. */
  private blob: Uint8Array | null = null;
  /** Arg-0 keymap u32 values (cmd 131 tags 248/1) — the adv read path. */
  private keymap: number[] | null = null;
  /** True while the displayed blob came from a write whose cmd-18
   *  read-back could not confirm it (K1 Pro caveat). */
  private blobUnconfirmed = false;
  /** Set while the initial reads are in flight. */
  private loading = false;

  constructor(root: HTMLElement) {
    root.replaceChildren();
    this.el = el('div', 'adv-page');
    root.append(this.el);
    this.unsub = subscribe(() => this.render());
    void this.refresh();
  }

  destroy(): void {
    this.unsub();
    this.el.remove();
  }

  // ── Data ────────────────────────────────────────────────────────────

  /** Re-read blob + arg-0 keymap from the device. */
  private async refresh(): Promise<void> {
    if (!app.connected || this.loading) return;
    this.loading = true;
    try {
      const s = app.connected.session;
      // Sequential — concurrent feature reports poison the session.
      const rawBlob = await s.advKeyConfig();
      const km = await s.keyValues(0);
      this.blob = normalizeBlob(rawBlob);
      this.keymap = km.map((v) => v >>> 0);
      this.blobUnconfirmed = false;
    } catch (e) {
      setStatus(t('adv.readFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private entries(): ReturnType<typeof historyEntries> {
    return this.blob ? historyEntries(this.blob) : [];
  }

  private bindings(): AdvBinding[] {
    return this.keymap ? scanAdvBindings(this.keymap) : [];
  }

  // ── Render ──────────────────────────────────────────────────────────

  private render(): void {
    this.el.replaceChildren();
    if (!app.connected || !app.snapshot) {
      const c = el('section', 'card');
      c.append(el('h2', '', t('adv.title')));
      const body = el('div', 'card-body');
      body.append(
        el('p', 'hint', t('adv.connectBlurb')),
      );
      c.append(body);
      this.el.append(c);
      return;
    }
    if (this.blob === null || this.keymap === null) {
      const c = el('section', 'card');
      c.append(el('h2', '', t('adv.title')));
      const body = el('div', 'card-body');
      body.append(el('p', 'hint', this.loading ? t('adv.reading') : t('adv.unavailable')));
      const r = btn(t('shell.refresh'));
      r.disabled = this.busy;
      r.addEventListener('click', () => void this.refresh());
      body.append(r);
      c.append(body);
      this.el.append(c);
      return;
    }

    this.renderInfo();
    // Vendor order on the page: MT, SOCD, TGL sections.
    this.renderKindSection('mt');
    this.renderKindSection('socd');
    this.renderKindSection('tgl');
  }

  private renderInfo(): void {
    const c = el('section', 'card');
    c.append(el('h2', '', t('adv.cardTitle')));
    const body = el('div', 'card-body');
    const entries = this.entries();
    const bindings = this.bindings();
    const chips = el('div', 'chip-row');
    for (const k of ['mt', 'socd', 'tgl'] as const) {
      chips.append(
        el('span', 'chip', t('adv.chipCounts', {
          label: KIND_LABEL[k],
          hist: entries.filter((e) => e.kind === k).length,
          bound: bindings.filter((b) => b.kind === k).length,
        })),
      );
    }
    body.append(chips);
    body.append(el('p', 'hint', t('adv.hint')));
    const tech = el('details', 'advanced');
    tech.append(el('summary', '', t('common.technicalDetails')));
    const techBody = el('div', 'advanced-body');
    techBody.append(el('p', 'hint', t('adv.techHint', { n: ADV_BLOB_BYTES })));
    tech.append(techBody);
    body.append(tech);
    if (this.blobUnconfirmed) {
      body.append(el('p', 'hint warn', t('adv.unconfirmedWarn')));
    }
    const r = btn(t('shell.refresh'));
    r.disabled = this.busy;
    r.addEventListener('click', () => void this.refresh());
    body.append(r);
    c.append(body);
    this.el.append(c);
  }

  // ── Per-kind section ────────────────────────────────────────────────

  private renderKindSection(kind: AdvKind): void {
    const entries = this.entries().filter((e) => e.kind === kind);
    const bindings = this.bindings().filter((b) => b.kind === kind);
    const c = el('section', 'card');
    c.append(el('h2', '', t('adv.kindTitle', { kind: KIND_LABEL[kind] })));
    const body = el('div', 'card-body');

    // Bindings table.
    if (bindings.length === 0) {
      body.append(el('p', 'hint', t('adv.noneBound')));
    } else {
      const table = el('table', 'macro-table');
      const head = el('tr');
      for (const h of [t('adv.colSlot'), t('adv.colPos'), t('adv.colSetting'), t('adv.colDetail'), t('adv.colSaved'), '']) {
        head.append(el('th', '', h));
      }
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      const tbody = el('tbody');
      for (const b of bindings) {
        const tr = el('tr');
        const payload = this.blob ? bindingPayload(this.blob, b) : null;
        const payloadText = payload
          ? payload.map((v) => valueText(v)).join(', ')
          : t('adv.noSaved');
        const setting = el('td', 'mono', valueLabel(b.value) || KIND_LABEL[b.kind]);
        setting.title = hex8(b.value);
        const saved = el('td', 'mono adv-payload', payloadText);
        if (payload) saved.title = valuesTitle(payload);
        tr.append(
          el('td', 'mono', `#${b.index}`),
          el('td', 'mono', String(b.pos)),
          setting,
          el('td', '', detailText(b)),
          saved,
        );
        const actions = el('td', 'macro-row-actions');
        const un = btn(t('adv.unbind'), t('adv.unbindWhy'));
        un.disabled = this.busy;
        un.addEventListener('click', () => void this.unbind(b));
        actions.append(un);
        tr.append(actions);
        tbody.append(tr);
      }
      table.append(tbody);
      body.append(table);
    }

    // History table.
    if (entries.length > 0) {
      body.append(el('p', 'hint', t('adv.savedOnKb')));
      const htable = el('table', 'macro-table');
      const hhead = el('tr');
      for (const h of [t('adv.colPos'), t('adv.colStored')]) hhead.append(el('th', '', h));
      const hthead = el('thead');
      hthead.append(hhead);
      htable.append(hthead);
      const htbody = el('tbody');
      for (const e of entries) {
        const tr = el('tr');
        const saved = el('td', 'mono', e.values.map((v) => valueText(v)).join(', '));
        saved.title = valuesTitle(e.values);
        tr.append(el('td', 'mono', String(e.slot)), saved);
        htbody.append(tr);
      }
      htable.append(htbody);
      body.append(htable);
    }

    // Add form.
    this.renderAddForm(body, kind);

    c.append(body);
    this.el.append(c);
  }

  /** Keymap-slot picker: `#index — label` for every arg-0 slot. */
  private slotSelect(exclude: number[] = []): HTMLSelectElement {
    const sel = el('select', 'macro-select adv-slot-select') as HTMLSelectElement;
    const km = this.keymap ?? [];
    km.forEach((v, i) => {
      if (exclude.includes(i)) return;
      const o = el('option', '', `#${i} — ${keyValueLabel(decodeKeyValue(v)) || t('common.empty')}`);
      o.title = hex8(v);
      o.value = String(i);
      sel.append(o);
    });
    return sel;
  }

  /** Key-value picker for MT tap/hold: vendor `Ca[]` pool + (none). */
  private valueSelect(): HTMLSelectElement {
    const sel = el('select', 'macro-select') as HTMLSelectElement;
    const none = el('option', '', t('common.noneShort'));
    none.value = String(POOL_UNASSIGN.value);
    sel.append(none);
    for (const e of KEY_POOL as readonly PoolEntry[]) {
      const o = el('option', '', e.name);
      o.title = hex8(e.value);
      o.value = String(e.value >>> 0);
      sel.append(o);
    }
    return sel;
  }

  private renderAddForm(body: HTMLElement, kind: AdvKind): void {
    body.append(el('p', 'hint', this.addHint(kind)));
    const row = el('div', 'macro-bind-row');

    if (kind === 'mt') {
      const bind = this.slotSelect();
      bind.value = String(this.firstBindableSlot());
      row.append(field(t('adv.fKeyToChange'), bind));
      const tap = this.valueSelect();
      tap.value = '4'; // 'A' (HID usage 0x04)
      row.append(field(t('adv.fTap'), tap));
      const hold = this.valueSelect();
      hold.value = '131072'; // L_shift (vendor pool value)
      row.append(field(t('adv.fHold'), hold));
      const time = el('input', 'macro-num') as HTMLInputElement;
      time.type = 'number';
      time.min = '0';
      time.max = '100';
      time.step = '1';
      time.value = '50';
      time.title = t('adv.holdTimeWhy');
      row.append(field(t('adv.fHoldTime'), time));
      body.append(row);
      const go = btn(t('adv.addMt'), t('adv.saveToKb'));
      go.classList.add('primary');
      go.disabled = this.busy;
      go.title = t('adv.saveToKb');
      go.addEventListener('click', () => void this.addMt(bind, tap, hold, time));
      body.append(go);
    } else if (kind === 'socd') {
      const keyA = this.slotSelect();
      keyA.value = String(this.firstBindableSlot());
      row.append(field(t('adv.fKeyA'), keyA));
      const keyB = this.slotSelect([Number(keyA.value)]);
      row.append(field(t('adv.fKeyB'), keyB));
      keyA.addEventListener('change', () => {
        // Keep B distinct from A.
        const cur = Number(keyB.value);
        keyB.replaceChildren();
        const km = this.keymap ?? [];
        km.forEach((v, i) => {
          if (i === Number(keyA.value)) return;
          const o = el('option', '', `#${i} — ${keyValueLabel(decodeKeyValue(v)) || t('common.empty')}`);
          o.title = hex8(v);
          o.value = String(i);
          keyB.append(o);
        });
        if (cur !== Number(keyA.value) && km[cur] !== undefined) keyB.value = String(cur);
      });
      const dir = el('select', 'macro-select') as HTMLSelectElement;
      for (const d of SOCD_DIRECTIONS) {
        const o = el('option', '', t(d.labelKey));
        o.value = String(d.id);
        dir.append(o);
      }
      row.append(field(t('adv.fDirection'), dir));
      body.append(row);
      const go = btn(t('adv.addSocd'), t('adv.saveToKb'));
      go.classList.add('primary');
      go.disabled = this.busy;
      go.addEventListener('click', () => void this.addSocd(keyA, keyB, dir));
      body.append(go);
    } else {
      const bind = this.slotSelect();
      bind.value = String(this.firstBindableSlot());
      row.append(field(t('adv.fKeyToChange'), bind));
      const toggle = this.slotSelect([Number(bind.value)]);
      row.append(field(t('adv.fToggleTarget'), toggle));
      bind.addEventListener('change', () => {
        const cur = Number(toggle.value);
        const km = this.keymap ?? [];
        if (cur !== Number(bind.value) && km[cur] !== undefined) toggle.value = String(cur);
      });
      body.append(row);
      const go = btn(t('adv.addTgl'), t('adv.saveToKb'));
      go.classList.add('primary');
      go.disabled = this.busy;
      go.addEventListener('click', () => void this.addTgl(bind, toggle));
      body.append(go);
    }
  }

  private addHint(kind: AdvKind): string {
    switch (kind) {
      case 'mt':
        return t('adv.addHintMt');
      case 'socd':
        return t('adv.addHintSocd');
      case 'tgl':
        return t('adv.addHintTgl');
    }
  }

  /** First keymap slot that is not already adv/macro-bound (value 0 or plain). */
  private firstBindableSlot(): number {
    const km = this.keymap ?? [];
    for (let i = 0; i < km.length; i++) {
      const tag = ((km[i] ?? 0) >>> 24) & 0xff;
      if (![0x03, 0x20, 0x21, 0x22].includes(tag)) return i;
    }
    return 0;
  }

  // ── Actions ─────────────────────────────────────────────────────────

  /**
   * Shared write path — mirrors `Kb916Adv::Set`: plan purely, confirm,
   * then the vendor's two writes in order (keymap cmd-3 0/2 channel,
   * then history cmd 18). The keymap write throws on read-back
   * mismatch; the history write reports verified honestly.
   */
  private async applyPlan(plan: AdvPlan, desc: string): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot) return;
    if (
      !window.confirm(t('adv.confirmWrite', { desc }))
    ) {
      return;
    }
    this.busy = true;
    this.render();
    const s = app.connected.session;
    try {
      await s.writeKeyConfiguration(plan.keymap);
      const ho = await s.writeAdvKeyConfig(plan.blob);

      // Refresh what we can trust: the arg-0 keymap (248/1 read shows
      // the persisted binding) and — only when the device confirmed it —
      // the blob. On K1 Pro cmd-146 is unreliable for ~60 s after cmd 18,
      // so an unconfirmed write keeps the intended blob locally and is
      // flagged `blobUnconfirmed`.
      const km = await s.keyValues(0).catch(() => null);
      if (km) this.keymap = km.map((v) => v >>> 0);
      this.blob = plan.blob;
      this.blobUnconfirmed = !ho.verified;
      // The keys page caches arg-0 too — drop it so labels refresh.
      app.snapshot.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});

      const hist = ho.verified ? t('adv.histSaved') : t('adv.histUnconfirmed');
      setStatus(t('adv.savedOk', { desc, hist }));
      emit();
    } catch (e) {
      setStatus(t('adv.saveFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      // The keymap half may have landed; refresh both reads.
      void this.refresh();
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async addMt(bind: HTMLSelectElement, tap: HTMLSelectElement, hold: HTMLSelectElement, time: HTMLInputElement): Promise<void> {
    if (!this.blob || !this.keymap) return;
    const key = Number(bind.value);
    const holdTime = Number(time.value);
    if (!Number.isInteger(holdTime) || holdTime < 0 || holdTime > 100) {
      setStatus(t('adv.badHoldTime'), true);
      return;
    }
    const tapV = Number(tap.value) >>> 0;
    const holdV = Number(hold.value) >>> 0;
    let plan: AdvPlan;
    try {
      plan = planMt(this.blob, this.keymap, key, tapV, holdV, holdTime);
    } catch (e) {
      setStatus(t('adv.mtFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      return;
    }
    const tapName = valueLabel(tapV) || hex8(tapV);
    const holdName = valueLabel(holdV) || hex8(holdV);
    await this.applyPlan(
      plan,
      t('adv.mtDesc', {
        key,
        old: keyValueLabel(decodeKeyValue(this.keymap[key] ?? 0)) || t('common.empty'),
        tap: tapName,
        hold: holdName,
        ms: holdTime * 10,
      }),
    );
  }

  private async addSocd(keyA: HTMLSelectElement, keyB: HTMLSelectElement, dir: HTMLSelectElement): Promise<void> {
    if (!this.blob || !this.keymap) return;
    const a = Number(keyA.value);
    const b = Number(keyB.value);
    const d = Number(dir.value);
    let plan: AdvPlan;
    try {
      plan = planSocd(this.blob, this.keymap, a, b, d);
    } catch (e) {
      setStatus(t('adv.socdFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      return;
    }
    const dirLabel = SOCD_DIRECTIONS.find((x) => x.id === d)?.labelKey
      ? t(SOCD_DIRECTIONS.find((x) => x.id === d)!.labelKey)
      : String(d);
    await this.applyPlan(
      plan,
      t('adv.socdDesc', { a, b, dir: dirLabel }),
    );
  }

  private async addTgl(bind: HTMLSelectElement, toggle: HTMLSelectElement): Promise<void> {
    if (!this.blob || !this.keymap) return;
    const key = Number(bind.value);
    const toggleIdx = Number(toggle.value);
    let plan: AdvPlan;
    try {
      plan = planTgl(this.blob, this.keymap, key, toggleIdx);
    } catch (e) {
      setStatus(t('adv.tglFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      return;
    }
    const tgt = this.keymap[toggleIdx] ?? 0;
    await this.applyPlan(
      plan,
      t('adv.tglDesc', { key, t: toggleIdx, v: valueLabel(tgt) || hex8(tgt) }),
    );
  }

  /** Clear one adv binding: write 0 to the keymap slot via the normal
   *  cmd-3 keymap write (the documented `omg kb916 set key` path).
   *  The history entry stays — there is no wire delete. */
  private async unbind(b: AdvBinding): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot || !this.keymap) return;
    const oldLabel = keyValueLabel(decodeKeyValue(b.value)) || hex8(b.value);
    if (
      !window.confirm(
        t('adv.unbindQ', { kind: KIND_LABEL[b.kind], i: b.index, old: oldLabel }),
      )
    ) {
      return;
    }
    this.busy = true;
    this.render();
    try {
      const values = this.keymap.slice();
      while (values.length < KEYMAP_ENTRIES) values.push(0);
      values[b.index] = 0;
      await app.connected.session.writeKeymap(0, 0, values);
      this.keymap = values.map((v) => v >>> 0);
      app.snapshot.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});
      setStatus(t('adv.unbound', { kind: KIND_LABEL[b.kind], i: b.index }));
      emit();
    } catch (e) {
      setStatus(t('adv.unbindFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      void this.refresh();
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

