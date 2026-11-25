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

import { app, emit, ensureKeymap, keymapBase, setStatus, subscribe } from './state.ts';
import { guardKeymapBase, isOpaqueKeymapValue } from './keymap-guard.ts';
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
import { confirmDialog } from './modal.ts';

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
  return label !== '' && !label.startsWith('0x') ? label : '(custom value)';
}

/** `title` tooltip carrying the raw hex for a list of values. */
function valuesTitle(values: readonly number[]): string {
  return values.map((v) => hex8(v)).join(', ');
}

/** Human-readable detail for one binding's low bits. */
function detailText(b: AdvBinding): string {
  const d = b.detail;
  if (d.kind === 'socd') {
    const dirs = ['last-input priority', 'key A priority', 'key B priority', 'all-cancel'];
    return `${dirs[d.direction] ?? `mode ${d.direction}`}${d.keyB ? ' · involves key B' : ' · involves key A'}`;
  }
  if (d.kind === 'mt') return `hold after ${d.time * 10} ms`
  return 'toggle';
}

const SOCD_DIRECTIONS: readonly { id: number; label: string }[] = [
  { id: 0, label: 'Last input wins' },
  { id: 1, label: 'Key A priority' },
  { id: 2, label: 'Key B priority' },
  { id: 3, label: 'All cancel' },
];

// Plain-language section titles (the vendor SOCD/MT/TGL jargon stays in
// the short KIND_LABEL used inside status messages).
const KIND_TITLE: Record<AdvKind, string> = {
  mt: 'Tap-or-hold keys (MT)',
  socd: 'Opposing keys (SOCD)',
  tgl: 'Toggle keys (TGL)',
};

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
      // Fresh, guarded read of the arg-0 table (§Safety 6): drop the
      // decode cache so this is a real device read, then require a
      // non-empty, u32-clean base whose length matches any previous
      // good read — a short/empty/corrupt read must never become the
      // base of a whole-table write.
      app.snapshot?.keymaps.delete(0);
      const km = guardKeymapBase(await keymapBase(0), {
        arg: 0,
        expectedLen: this.keymap?.length,
      });
      this.blob = normalizeBlob(rawBlob);
      this.keymap = km;
      this.blobUnconfirmed = false;
    } catch (e) {
      // An untrusted read must not leave a stale table behind that a
      // later write could be built on.
      this.keymap = null;
      setStatus(`Could not read advanced-key settings: ${e instanceof Error ? e.message : String(e)}`, true);
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
      c.append(el('h2', '', 'Advanced keys'));
      const body = el('div', 'card-body');
      body.append(
        el('p', 'hint', 'Press the Connect button at the top right to manage advanced keys — opposing-key, tap-or-hold and toggle functions.'),
      );
      c.append(body);
      this.el.append(c);
      return;
    }
    if (this.blob === null || this.keymap === null) {
      const c = el('section', 'card');
      c.append(el('h2', '', 'Advanced keys'));
      const body = el('div', 'card-body');
      body.append(el('p', 'hint', this.loading ? 'Reading advanced key settings…' : 'Advanced key settings unavailable — press Refresh.'));
      const r = btn('Refresh');
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
    c.append(el('h2', '', 'Advanced keys'));
    const body = el('div', 'card-body');
    const entries = this.entries();
    const bindings = this.bindings();
    const chips = el('div', 'chip-row');
    for (const k of ['mt', 'socd', 'tgl'] as const) {
      chips.append(
        el('span', 'chip', `${KIND_TITLE[k]}: ${entries.filter((e) => e.kind === k).length} saved · ${bindings.filter((b) => b.kind === k).length} in use`),
      );
    }
    body.append(chips);
    body.append(
      el(
        'p',
        'hint',
        'SOCD makes two opposing keys (like W and S) share one output, ' +
          'mod-tap (MT) gives a key two actions depending on how long you hold it, ' +
          'and toggle (TGL) makes a key switch another key on or off with each press. ' +
          'There is no delete on the device — "Remove" clears the key\'s assignment ' +
          'but keeps its saved settings.',
      ),
    );
    const tech = el('details', 'advanced');
    tech.append(el('summary', '', 'Technical details'));
    const techBody = el('div', 'advanced-body');
    techBody.append(
      el(
        'p',
        'hint',
        `Settings storage: ${ADV_BLOB_BYTES} bytes on the keyboard. ` +
          'The actual key actions are stored in the key assignments.',
      ),
    );
    tech.append(techBody);
    body.append(tech);
    if (this.blobUnconfirmed) {
      body.append(
        el(
          'p',
          'hint warn',
          'The last settings write was sent but the keyboard did not confirm it. ' +
            'On K1 Pro firmware this particular save does not always stick — ' +
            'press Refresh in a minute to check, or try again.',
        ),
      );
    }
    const r = btn('Refresh');
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
    c.append(el('h2', '', KIND_TITLE[kind]));
    const body = el('div', 'card-body');

    // Bindings table.
    if (bindings.length === 0) {
      body.append(el('p', 'hint', 'No keys use this kind of advanced function yet.'));
    } else {
      const table = el('table', 'macro-table');
      const head = el('tr');
      for (const h of ['Key', '#', 'Function', 'How it works', 'Saved settings', '']) {
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
          : '(no saved settings)';
        const setting = el('td', 'mono', valueLabel(b.value) || KIND_LABEL[b.kind]);
        setting.title = hex8(b.value);
        const saved = el('td', 'mono adv-payload', payloadText);
        if (payload) saved.title = valuesTitle(payload);
        tr.append(
          el('td', 'mono', `Key ${b.index}`),
          el('td', 'mono', String(b.pos)),
          setting,
          el('td', '', detailText(b)),
          saved,
        );
        const actions = el('td', 'macro-row-actions');
        const un = btn('Remove', 'Remove this key\'s advanced function. The saved settings stay stored on the keyboard.');
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
      body.append(el('p', 'hint', 'Saved settings on the keyboard:'));
      const htable = el('table', 'macro-table');
      const hhead = el('tr');
      for (const h of ['#', 'Saved settings']) hhead.append(el('th', '', h));
      const hthead = el('thead');
      hthead.append(hhead);
      htable.append(hthead);
      const htbody = el('tbody');
      for (const e of entries) {
        const tr = el('tr');
        const saved = el('td', 'mono', e.values.map((v) => valueText(v)).join(', '));
        saved.title = valuesTitle(e.values);
        tr.append(el('td', 'mono', `#${e.slot}`), saved);
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
      // Opaque slots (undocumented tags, e.g. 0x08) are never bind
      // targets — they must be preserved byte-identical (§Safety 7).
      if (exclude.includes(i) || isOpaqueKeymapValue(v)) return;
      const o = el('option', '', `Key ${i} — ${keyValueLabel(decodeKeyValue(v)) || '(empty)'}`);
      o.title = hex8(v);
      o.value = String(i);
      sel.append(o);
    });
    return sel;
  }

  /** Key-value picker for MT tap/hold: vendor `Ca[]` pool + (none). */
  private valueSelect(): HTMLSelectElement {
    const sel = el('select', 'macro-select') as HTMLSelectElement;
    const none = el('option', '', '(none)');
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
      row.append(field('Key to change', bind));
      const tap = this.valueSelect();
      tap.value = '4'; // 'A' (HID usage 0x04)
      row.append(field('Tap (short press)', tap));
      const hold = this.valueSelect();
      hold.value = '131072'; // L_shift (vendor pool value)
      row.append(field('Hold (long press)', hold));
      const time = el('input', 'macro-num') as HTMLInputElement;
      time.type = 'number';
      time.min = '0';
      time.max = '100';
      time.step = '1';
      time.value = '50';
      time.title = 'How long to hold the key before the Hold action fires — each step of 1 equals 10 ms';
      row.append(field('Hold time', time));
      body.append(row);
      const go = btn(`Add MT key`, 'Saves the key binding and its settings to the keyboard');
      go.classList.add('primary');
      go.disabled = this.busy;
      go.title = 'Saves the key binding and its settings to the keyboard';
      go.addEventListener('click', () => void this.addMt(bind, tap, hold, time));
      body.append(go);
    } else if (kind === 'socd') {
      const keyA = this.slotSelect();
      keyA.value = String(this.firstBindableSlot());
      row.append(field('Key A', keyA));
      const keyB = this.slotSelect([Number(keyA.value)]);
      row.append(field('Key B', keyB));
      keyA.addEventListener('change', () => {
        // Keep B distinct from A.
        const cur = Number(keyB.value);
        keyB.replaceChildren();
        const km = this.keymap ?? [];
        km.forEach((v, i) => {
          if (i === Number(keyA.value) || isOpaqueKeymapValue(v)) return;
          const o = el('option', '', `Key ${i} — ${keyValueLabel(decodeKeyValue(v)) || '(empty)'}`);
          o.title = hex8(v);
          o.value = String(i);
          keyB.append(o);
        });
        if (cur !== Number(keyA.value) && km[cur] !== undefined) keyB.value = String(cur);
      });
      const dir = el('select', 'macro-select') as HTMLSelectElement;
      for (const d of SOCD_DIRECTIONS) {
        const o = el('option', '', d.label);
        o.value = String(d.id);
        dir.append(o);
      }
      row.append(field('Direction', dir));
      body.append(row);
      const go = btn('Add SOCD pair', 'Saves the key bindings and settings to the keyboard');
      go.classList.add('primary');
      go.disabled = this.busy;
      go.addEventListener('click', () => void this.addSocd(keyA, keyB, dir));
      body.append(go);
    } else {
      const bind = this.slotSelect();
      bind.value = String(this.firstBindableSlot());
      row.append(field('Key to change', bind));
      const toggle = this.slotSelect([Number(bind.value)]);
      row.append(field('Key to toggle', toggle));
      bind.addEventListener('change', () => {
        const cur = Number(toggle.value);
        const km = this.keymap ?? [];
        if (cur !== Number(bind.value) && km[cur] !== undefined) toggle.value = String(cur);
      });
      body.append(row);
      const go = btn('Add TGL key', 'Saves the key binding and settings to the keyboard');
      go.classList.add('primary');
      go.disabled = this.busy;
      go.addEventListener('click', () => void this.addTgl(bind, toggle));
      body.append(go);
    }
  }

  private addHint(kind: AdvKind): string {
    switch (kind) {
      case 'mt':
        return 'Tap-or-hold: a short press does the Tap action, a long press does the Hold ' +
          'action after the threshold. The key\'s current action is replaced.';
      case 'socd':
        return 'Opposing keys: two opposite-direction keys (like W and S) share one output; Direction picks what happens ' +
          'when both are pressed at once. The keys\' current actions are saved.';
      case 'tgl':
        return 'Toggle: pressing the key switches the other key\'s action on or off ' +
          'with each press.';
    }
  }

  /** First keymap slot that is not already adv/macro-bound (value 0 or plain)
   *  and not an opaque unknown-tag value (§Safety 7). */
  private firstBindableSlot(): number {
    const km = this.keymap ?? [];
    for (let i = 0; i < km.length; i++) {
      const v = km[i] ?? 0;
      const tag = (v >>> 24) & 0xff;
      if ([0x03, 0x20, 0x21, 0x22].includes(tag)) continue;
      if (isOpaqueKeymapValue(v)) continue;
      return i;
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
    const ok = await confirmDialog({
      title: desc,
      bodyText:
        'This saves the change to the keyboard — other keys and settings stay the same. ' +
        'Note: on some firmware the saved settings may not stick — the page will ' +
        'tell you honestly if that happens.',
      hint: 'Only this key\u2019s advanced function changes; the rest of the keymap is untouched.',
      impact: {
        affected: ['Advanced key function'],
        persistent: true,
        // Auto-captured profile baseline exists, but advanced-key
        // settings blobs are not a restorable profile section.
        backupCaptured: true,
        rollback: 'partial',
        restartRisk: false,
      },
      confirmLabel: 'Save to keyboard',
    });
    if (!ok) return;
    this.busy = true;
    this.render();
    const s = app.connected.session;
    try {
      // §Safety 6 — `plan.keymap` is a whole-table write; refuse to send
      // one built on an empty/short/corrupt base.
      const km = guardKeymapBase(plan.keymap, { arg: 0 });
      // §Safety 7 — a plan may only rewrite slots whose previous value
      // is known or empty; an opaque (unknown-tag) slot must survive
      // byte-identical, so any plan that changes one is refused here
      // even if it slipped past the pickers.
      if (this.keymap) {
        for (let i = 0; i < km.length; i++) {
          const before = this.keymap[i];
          if (before !== undefined && km[i] !== before && isOpaqueKeymapValue(before)) {
            throw new Error(
              `key ${i} holds a value this app does not recognize — refusing to overwrite it`,
            );
          }
        }
      }
      await s.writeKeyConfiguration(km);
      const ho = await s.writeAdvKeyConfig(plan.blob);

      // Refresh what we can trust: the arg-0 keymap (248/1 read shows
      // the persisted binding) and — only when the device confirmed it —
      // the blob. On K1 Pro cmd-146 is unreliable for ~60 s after cmd 18,
      // so an unconfirmed write keeps the intended blob locally and is
      // flagged `blobUnconfirmed`.
      const back = await s.keyValues(0).catch(() => null);
      if (back) {
        try {
          // Display-only refresh, but it seeds the next write's base —
          // it must pass the same guard, pinned to the length we just
          // verified on the wire.
          this.keymap = guardKeymapBase(back.map((v) => v >>> 0), {
            arg: 0,
            expectedLen: km.length,
          });
        } catch {
          this.keymap = null; // untrusted read-back — Refresh to retry
        }
      }
      this.blob = plan.blob;
      this.blobUnconfirmed = !ho.verified;
      // The keys page caches arg-0 too — drop it so labels refresh.
      app.snapshot.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});

      const hist = ho.verified
        ? 'settings saved and checked'
        : 'settings sent but NOT confirmed (this firmware may not keep them — press Refresh in a minute to check)';
      setStatus(`${desc} — key binding saved; ${hist}.`);
      emit();
    } catch (e) {
      setStatus(`Could not save the advanced-key change: ${e instanceof Error ? e.message : String(e)}`, true);
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
    const t = Number(time.value);
    if (!Number.isInteger(t) || t < 0 || t > 100) {
      setStatus('Hold time must be a whole number between 0 and 100', true);
      return;
    }
    const tapV = Number(tap.value) >>> 0;
    const holdV = Number(hold.value) >>> 0;
    let plan: AdvPlan;
    try {
      plan = planMt(this.blob, this.keymap, key, tapV, holdV, t);
    } catch (e) {
      setStatus(`Could not set up that mod-tap key: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const tapName = valueLabel(tapV) || hex8(tapV);
    const holdName = valueLabel(holdV) || hex8(holdV);
    await this.applyPlan(
      plan,
      `MT on key ${key} (${keyValueLabel(decodeKeyValue(this.keymap[key] ?? 0)) || 'empty'}): ` +
        `tap ${tapName}, hold ${holdName}, after ${t * 10} ms`,
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
      setStatus(`Could not set up that SOCD pair: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const dirLabel = SOCD_DIRECTIONS.find((x) => x.id === d)?.label ?? String(d);
    await this.applyPlan(
      plan,
      `SOCD on keys ${a} + ${b}: ${dirLabel}`,
    );
  }

  private async addTgl(bind: HTMLSelectElement, toggle: HTMLSelectElement): Promise<void> {
    if (!this.blob || !this.keymap) return;
    const key = Number(bind.value);
    const t = Number(toggle.value);
    let plan: AdvPlan;
    try {
      plan = planTgl(this.blob, this.keymap, key, t);
    } catch (e) {
      setStatus(`Could not set up that toggle key: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const tgt = this.keymap[t] ?? 0;
    await this.applyPlan(
      plan,
      `TGL on key ${key} toggles key ${t} (${valueLabel(tgt) || 'custom'})`,
    );
  }

  /** Clear one adv binding: write 0 to the keymap slot via the normal
   *  cmd-3 keymap write (the documented `omg kb916 set key` path).
   *  The history entry stays — there is no wire delete. */
  private async unbind(b: AdvBinding): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot || !this.keymap) return;
    const oldLabel = keyValueLabel(decodeKeyValue(b.value)) || hex8(b.value);
    const ok = await confirmDialog({
      title: `Remove the ${KIND_LABEL[b.kind]} function from key ${b.index}?`,
      bodyText:
        `The key currently runs ${oldLabel}. Its saved settings stay stored on ` +
        'the keyboard (the device has no delete), but the key goes back to normal — ' +
        'this writes 0 to that one key position and checks the write.',
      impact: {
        affected: [`Advanced function on key ${b.index}`],
        persistent: true,
        backupCaptured: true,
        rollback: 'partial',
        restartRisk: false,
      },
      confirmLabel: 'Remove function',
      danger: true,
    });
    if (!ok) return;
    this.busy = true;
    this.render();
    try {
      // §Safety 6 — rebuild from a FRESH guarded read, never from the
      // displayed table padded with zeros. A short/empty/corrupt read
      // aborts before any bytes are sent.
      app.snapshot.keymaps.delete(0);
      const base = guardKeymapBase(await keymapBase(0), {
        arg: 0,
        expectedLen: this.keymap?.length,
      });
      if (b.index >= base.length) {
        throw new Error(
          `key ${b.index} is past the ${base.length} keys the keyboard reports — nothing was sent`,
        );
      }
      const values = base.slice();
      while (values.length < KEYMAP_ENTRIES) values.push(0);
      values[b.index] = 0;
      await app.connected.session.writeKeymap(0, 0, values);
      // Keep the displayed table at the device's real length (not the
      // 128-slot padded wire form) so the next refresh's length check
      // compares like with like.
      const displayed = base.slice();
      displayed[b.index] = 0;
      this.keymap = displayed;
      app.snapshot.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});
      setStatus(`Removed the ${KIND_LABEL[b.kind]} function from key ${b.index} — checked on the keyboard.`);
      emit();
    } catch (e) {
      setStatus(`Could not remove that function: ${e instanceof Error ? e.message : String(e)}`, true);
      void this.refresh();
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

