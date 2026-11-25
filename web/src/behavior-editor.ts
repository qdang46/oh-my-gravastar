/**
 * Configure-key behavior editor — bead vzx. Mounted inside the Keys
 * page (`remap.ts`) when exactly one key is selected; implements the
 * per-key "Configure key" flow from `docs/UIUX-SPEC.md` §3:
 *
 * - **Easy mode**: pick ONE action — a plain keymap value (staged through
 *   the existing `StagedEdits`/Save flow) or a tap=X / hold=Y style
 *   preset that maps onto the supported adv behaviors (MT/SOCD/TGL).
 * - **Advanced mode**: raw MT/SOCD/TGL parameters — timing in ms,
 *   direction ids, raw u32 key values / keymap indices.
 *
 * Honesty contract:
 * - every option is gated by `core/capabilities.ts` (`adv_keys`) and the
 *   `docs/protocol-behaviors.md` verdicts via `behavior-core.ts`;
 *   unsupported behaviors render disabled WITH their reason;
 * - khub916 adv writes go through the SAME path as `advkeys.ts`
 *   (`planMt`/`planSocd`/`planTgl` → `writeKeyConfiguration` cmd-3 0/2 +
 *   `writeAdvKeyConfig` cmd 18) and bypass staged edits, so the Apply
 *   button says "Save to keyboard now" and the confirm dialog spells out
 *   that it writes immediately (modal.ts — never native confirm);
 * - cmd-18 persistence is unverified on K1 Pro — the caveat from the
 *   capability registry is shown before Apply and the post-write status
 *   reports "sent, not confirmed" honestly.
 */

// Import the state slices directly (not the `./state.ts` barrel): the
// barrel pulls in `state/connection.ts` → `hid.ts`, whose WebHID session
// class uses TS parameter properties that Node's type-stripping cannot
// parse — keeping this file importable under `scripts/test-*.ts`.
import { app, emit, setStatus } from './state/core.ts';
import { ensureKeymap, keymapBase } from './state/keymap.ts';
import { guardKeymapBase, isOpaqueKeymapValue } from './keymap-guard.ts';
import { KEY_POOL, POOL_UNASSIGN } from './keypool.ts';
import { KEYMAP_ENTRIES } from './proto/khub916.ts';
import {
  normalizeBlob,
  planMt,
  planSocd,
  planTgl,
  type AdvPlan,
} from './proto/advkey916.ts';
import { getCapabilities, protocolOf } from './core/capabilities.ts';
import type { DeviceLike } from './core/device-model.ts';
import {
  MT_TIME_MAX_MS,
  SOCD_DIRECTION_LABELS,
  behaviorCatalog,
  behaviorCard,
  behaviorValueLabel,
  splitBehaviorChoices,
  currentBehaviorSummary,
  describeAdvDraft,
  mtUnitsFromMs,
  parseU32Input,
  validateAdvDraft,
  type AdvDraft,
  type BehaviorId,
  type BehaviorOption,
} from './behavior-core.ts';
import { confirmDialog } from './modal.ts';

// ── Context supplied by remap.ts ───────────────────────────────────────

export interface ConfigureContext {
  /** Keymap arg being viewed (`layer | system<<2`); adv only on arg 0. */
  arg: number;
  /** Selected keymap slot index. */
  index: number;
  /** Physical block name ('' when unnamed). */
  keyName: string;
  /** Device-read u32 for (arg, index). */
  committed: number;
  /** Staged-aware effective u32 for (arg, index). */
  effective: number;
  /** Stage a plain keymap value on the selected key (StagedEdits). */
  stagePlain: (value: number) => void;
  /** True when arg-0 slot `index` has a staged (unsaved) edit. */
  hasStaged: (index: number) => boolean;
  /** Number of staged edits on arg 0 (User key set 1). */
  stagedCount: () => number;
  /** Display label for an arg-0 slot (staged-aware). */
  labelFor: (index: number) => string;
  /** Called after a successful immediate device write (clear undo history). */
  onDeviceWrite: () => void;
}

// ── Editor state (survives the per-emit page rebuilds) ─────────────────

interface AdvCache {
  /** Connection the cache belongs to (refetch on reconnect). */
  conn: unknown;
  blob: Uint8Array;
  /**
   * Arg-0 keymap u32 values — the base every adv whole-table write is
   * planned on. Always a guarded read (`keymapBase` →
   * `guardKeymapBase`, §Safety 6/7): empty/short/corrupt reads abort
   * instead of becoming a zero-padded write base, and opaque
   * unknown-tag slots pass through byte-identical.
   */
  keymap: number[];
}

export class BehaviorEditor {
  private mode: 'easy' | 'advanced' = 'easy';
  private choice: BehaviorId = 'plain';
  private primed = false;
  /** `arg*4096 + index` of the key the panel last rendered for. */
  private lastKeyId = -1;
  private plainValue = POOL_UNASSIGN.value;
  // MT draft fields.
  private tap: number | null = null;
  private hold: number | null = null;
  private holdMs = 200;
  // SOCD / TGL draft fields.
  private direction = 0;
  private partner: number | null = null;
  private target: number | null = null;
  /** Advanced-mode raw text inputs (kept verbatim while typing). */
  private tapRaw = '';
  private holdRaw = '';
  private partnerRaw = '';
  private targetRaw = '';
  private busy = false;
  private adv: AdvCache | null = null;
  private advPromise: Promise<AdvCache | null> | null = null;
  private advError = '';

  // ── small DOM helpers (same style as advkeys.ts) ────────────────────

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
  ): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    const wrap = this.el('label', 'macro-field');
    wrap.append(this.el('span', 'macro-field-label', label), input);
    return wrap;
  }

  // ── Device / capability helpers ─────────────────────────────────────

  private deviceLike(): DeviceLike | null {
    const c = app.connected;
    const snap = app.snapshot;
    if (!c || !snap) return null;
    return {
      vendorId: c.device.vendorId,
      productId: c.device.productId,
      productName: c.device.productName ?? null,
      uuid: snap.info.uuid,
      catalogModel: snap.info.catalogModel,
      catalogName: snap.info.catalogName,
      screenSize: snap.info.screenSize,
    };
  }

  private catalog(): BehaviorOption[] {
    const like = this.deviceLike();
    if (!like) return [];
    const protocol = protocolOf(like);
    return behaviorCatalog(protocol, getCapabilities(like).adv_keys);
  }

  private optionFor(id: BehaviorId): BehaviorOption | undefined {
    return this.catalog().find((o) => o.id === id);
  }

  // ── Adv-key data (blob + arg-0 keymap), cached per connection ───────

  private ensureAdv(force = false): Promise<AdvCache | null> {
    const conn = app.connected;
    if (!conn || !app.snapshot) return Promise.resolve(null);
    if (!force && this.adv && this.adv.conn === conn) return Promise.resolve(this.adv);
    if (this.advPromise) return this.advPromise;
    this.advError = '';
    this.advPromise = (async () => {
      try {
        const s = conn.session;
        // Sequential — concurrent feature reports poison the session.
        const rawBlob = await s.advKeyConfig();
        // §Safety 6 — drop the decode cache so this is a fresh device
        // read, then require a complete, u32-clean base pinned to the
        // length of any previous good read (same as advkeys.ts refresh).
        const prevLen = this.adv && this.adv.conn === conn ? this.adv.keymap.length : undefined;
        app.snapshot?.keymaps.delete(0);
        const km = guardKeymapBase(await keymapBase(0), { arg: 0, expectedLen: prevLen });
        this.adv = {
          conn,
          blob: normalizeBlob(rawBlob),
          keymap: km,
        };
      } catch (e) {
        this.advError = e instanceof Error ? e.message : String(e);
        this.adv = null;
      } finally {
        this.advPromise = null;
      }
      return this.adv;
    })();
    return this.advPromise;
  }

  // ── Bound slots / staged-edit conflicts ─────────────────────────────

  /** Keymap slots an adv write for `choice` would occupy. */
  private boundSlots(ctx: ConfigureContext): number[] {
    switch (this.choice) {
      case 'socd':
        return this.partner === null ? [ctx.index] : [ctx.index, this.partner];
      case 'mt':
      case 'tgl':
        return [ctx.index];
      default:
        return [];
    }
  }

  private stagedConflict(ctx: ConfigureContext): number[] {
    return this.boundSlots(ctx).filter((i) => ctx.hasStaged(i));
  }

  // ── Render ──────────────────────────────────────────────────────────

  /**
   * Rebuild the panel body. Called on every page sync — all widget
   * state lives in instance fields and is restored into the fresh DOM.
   */
  render(host: HTMLElement, ctx: ConfigureContext): void {
    host.replaceChildren();
    if (!app.connected || !app.snapshot) return;
    if (!this.primed) {
      this.primed = true;
      this.prefill(ctx);
    }
    // Selecting a different key resets per-key picks (partner/target are
    // keymap indices; the plain action defaults to that key's value).
    const keyId = ctx.arg * 4096 + ctx.index;
    if (this.lastKeyId !== keyId) {
      this.lastKeyId = keyId;
      this.partner = null;
      this.target = null;
      this.partnerRaw = '';
      this.targetRaw = '';
      if (this.choice === 'plain') this.plainValue = ctx.committed >>> 0;
      this.prefill(ctx);
    }

    const head = this.el('div', 'beh-head');
    head.append(
      this.el(
        'p',
        'hint',
        `Key ${ctx.index}${ctx.keyName ? ` (${ctx.keyName})` : ''} — ` +
          `currently ${this.valueText(ctx.effective) || 'nothing'}` +
          (ctx.effective !== ctx.committed ? ' (unsaved edit staged)' : ''),
      ),
    );
    // Existing adv binding on this key (arg-0 only): show + offer remove.
    if (ctx.arg === 0) {
      const summary = currentBehaviorSummary(ctx.committed);
      if (summary) {
        const row = this.el('div', 'beh-current');
        row.append(this.el('span', 'hint', `This key already runs ${summary}.`));
        const rm = this.el('button', 'btn beh-remove', 'Remove function') as HTMLButtonElement;
        rm.type = 'button';
        rm.disabled = this.busy || ctx.hasStaged(ctx.index);
        rm.title = ctx.hasStaged(ctx.index)
          ? 'This key has an unsaved staged change — save or discard it first'
          : 'Clear the advanced function (writes 0 to this key now)';
        rm.addEventListener('click', () => void this.removeAdv(ctx));
        row.append(rm);
        head.append(row);
      }
    }
    if (ctx.arg !== 0) {
      head.append(
        this.el(
          'p',
          'hint warn',
          'Advanced functions only exist on User key set 1 — switch to that ' +
            'tab to configure them. Here you can stage a plain key action.',
        ),
      );
    }
    host.append(head);

    // §Safety 7 — a slot holding an undocumented-tag value is opaque:
    // it must survive byte-identical, so the whole editor locks for it
    // (no staged plain edit, no adv bind, no remove).
    if (isOpaqueKeymapValue(ctx.committed)) {
      host.append(
        this.el(
          'p',
          'hint warn',
          'This key holds a setting this app does not recognize — it is ' +
            'locked so the unknown value is preserved.',
        ),
      );
      return;
    }

    // Mode tabs.
    const tabs = this.el('div', 'segment-bar beh-mode');
    for (const m of ['easy', 'advanced'] as const) {
      const b = this.el(
        'button',
        `segment-item${this.mode === m ? ' active' : ''}`,
        m === 'easy' ? 'Easy' : 'Advanced',
      ) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => {
        this.mode = m;
        this.render(host, ctx);
      });
      tabs.append(b);
    }
    host.append(tabs);

    this.renderChoices(host, ctx);
    this.renderForm(host, ctx);
    this.renderUnavailable(host);
  }

  private valueText(v: number): string {
    return behaviorValueLabel(v) || (v === 0 ? '' : 'custom value');
  }

  // ── Behavior picker ─────────────────────────────────────────────────

  /**
   * One behavior option as an action-first card: plain-language title +
   * subtitle (BEHAVIOR_CARDS), capability reason/caveat meta and the
   * same disabled gating as before — nothing about availability changed,
   * only the presentation (bead sl3).
   */
  private choiceRow(
    opt: BehaviorOption,
    arg0: boolean,
    host: HTMLElement,
    ctx: ConfigureContext,
  ): HTMLElement {
    const needsArg0 = opt.group === 'adv';
    const disabled = !opt.available || (needsArg0 && !arg0) || this.busy;
    const reason = !opt.available
      ? opt.reason
      : needsArg0 && !arg0
        ? 'advanced functions only exist on User key set 1'
        : undefined;
    const card = behaviorCard(opt.id);
    const row = this.el(
      'label',
      `beh-choice beh-card-opt${this.choice === opt.id ? ' beh-choice--on' : ''}`,
    );
    const radio = this.el('input') as HTMLInputElement;
    radio.type = 'radio';
    radio.name = 'beh-choice';
    radio.checked = this.choice === opt.id;
    radio.disabled = disabled;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        this.choice = opt.id;
        this.prefill(ctx);
        this.render(host, ctx);
      }
    });
    const text = this.el('span', 'beh-choice-text');
    text.append(this.el('span', 'beh-choice-label', card?.title ?? opt.label));
    if (card?.subtitle) {
      text.append(this.el('span', 'hint beh-choice-sub', card.subtitle));
    }
    const meta: string[] = [];
    if (opt.write === 'staged') meta.push('staged — applied on Save');
    if (opt.write === 'immediate') meta.push('writes immediately on Apply');
    if (opt.caveat) meta.push(opt.caveat);
    if (reason) meta.push(reason);
    if (meta.length) text.append(this.el('span', 'hint beh-choice-meta', meta.join(' · ')));
    row.append(radio, text);
    return row;
  }

  private renderChoices(host: HTMLElement, ctx: ConfigureContext): void {
    const catalog = this.catalog();
    const usable = catalog.filter((o) => o.group !== 'unavailable');
    // Adv options are additionally gated to arg 0 (bindings live there).
    const arg0 = ctx.arg === 0;
    const list = this.el('div', 'beh-choices');
    if (this.mode === 'easy') {
      // Progressive disclosure (bead sl3): everyday actions are cards;
      // jargon options (SOCD) sit behind "More customization". The
      // catalog order inside each tier is unchanged.
      const { primary, advanced } = splitBehaviorChoices(catalog);
      for (const opt of primary) list.append(this.choiceRow(opt, arg0, host, ctx));
      host.append(list);
      if (advanced.length > 0) {
        const det = this.el('details', 'beh-more');
        det.append(this.el('summary', '', 'More customization'));
        const inner = this.el('div', 'beh-choices');
        for (const opt of advanced) inner.append(this.choiceRow(opt, arg0, host, ctx));
        det.append(inner);
        host.append(det);
      }
      return;
    }
    // Advanced mode: flat list, catalog order, jargon labels allowed.
    for (const opt of usable) list.append(this.choiceRow(opt, arg0, host, ctx));
    host.append(list);
  }

  /** Sensible defaults when the editor first renders / a behavior is picked. */
  private prefill(ctx: ConfigureContext): void {
    if (this.choice === 'plain') {
      if (this.plainValue === POOL_UNASSIGN.value && ctx.committed !== 0) {
        this.plainValue = ctx.committed >>> 0;
      }
    } else if (this.choice === 'mt') {
      if (this.tap === null) this.tap = 4; // 'A'
      if (this.hold === null) this.hold = 131072; // L_shift (vendor pool)
      if (this.tapRaw === '') this.tapRaw = `0x${(this.tap >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
      if (this.holdRaw === '') this.holdRaw = `0x${(this.hold >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    } else if (this.choice === 'socd') {
      if (this.partner === null) this.partner = ctx.index === 0 ? 1 : 0;
      if (this.partnerRaw === '' && this.partner !== null) this.partnerRaw = String(this.partner);
    } else if (this.choice === 'tgl') {
      if (this.target === null) this.target = ctx.index === 0 ? 1 : 0;
      if (this.targetRaw === '' && this.target !== null) this.targetRaw = String(this.target);
    }
  }

  // ── Forms ───────────────────────────────────────────────────────────

  private renderForm(host: HTMLElement, ctx: ConfigureContext): void {
    const opt = this.optionFor(this.choice);
    if (!opt || !opt.available) {
      host.append(
        this.el(
          'p',
          'hint warn',
          opt?.reason ?? 'This behavior is not available on the connected device.',
        ),
      );
      return;
    }
    if (this.choice === 'plain') {
      this.renderPlainForm(host, ctx);
    } else if (this.choice === 'mt') {
      this.renderMtForm(host, ctx);
    } else if (this.choice === 'socd') {
      this.renderSocdForm(host, ctx);
    } else if (this.choice === 'tgl') {
      this.renderTglForm(host, ctx);
    }
  }

  /** Pool-value <select> (easy mode) — same pool as the page picker. */
  private valueSelect(value: number | null, onPick: (v: number) => void): HTMLSelectElement {
    const sel = this.el('select', 'macro-select beh-select') as HTMLSelectElement;
    const none = this.el('option', '', '(none)') as HTMLOptionElement;
    none.value = '0';
    sel.append(none);
    for (const e of KEY_POOL) {
      const o = this.el('option', '', e.name) as HTMLOptionElement;
      o.value = String(e.value >>> 0);
      o.title = `0x${(e.value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
      sel.append(o);
    }
    sel.value = String(value ?? 0);
    sel.addEventListener('change', () => onPick(Number(sel.value) >>> 0));
    return sel;
  }

  /** Raw u32 text input (advanced mode). */
  private rawValueInput(
    current: number | null,
    raw: string,
    onRaw: (s: string) => void,
    onPick: (v: number | null) => void,
  ): HTMLInputElement {
    const input = this.el('input', 'macro-num beh-raw') as HTMLInputElement;
    input.type = 'text';
    input.value =
      raw !== ''
        ? raw
        : current === null
          ? ''
          : `0x${(current >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    input.placeholder = '0x… or decimal, none = empty';
    input.title = 'Raw keymap value: 0x hex or decimal; "none" = no key';
    input.addEventListener('input', () => {
      onRaw(input.value);
      const t = input.value.trim();
      const v = t === '' ? null : parseU32Input(t);
      onPick(v);
      input.classList.toggle(
        'beh-invalid',
        v === null && t !== '' && t.toLowerCase() !== 'none',
      );
    });
    return input;
  }

  private renderPlainForm(host: HTMLElement, ctx: ConfigureContext): void {
    const wrap = this.el('div', 'beh-form');
    const sel = this.valueSelect(this.plainValue, (v) => {
      this.plainValue = v;
    });
    wrap.append(this.field('Key does', sel));
    const go = this.el('button', 'btn btn-primary', 'Stage this action') as HTMLButtonElement;
    go.type = 'button';
    go.title = 'Stages the change — it is written when you press Save on this key set';
    go.addEventListener('click', () => {
      ctx.stagePlain(this.plainValue >>> 0);
      setStatus(
        `Staged ${this.plainValue === 0 ? 'unassign' : behaviorValueLabel(this.plainValue) || 'custom value'} on key ${ctx.index} — press Save to write it.`,
      );
    });
    wrap.append(go);
    host.append(wrap);
  }

  private renderMtForm(host: HTMLElement, ctx: ConfigureContext): void {
    void ctx;
    const wrap = this.el('div', 'beh-form');
    const row = this.el('div', 'macro-bind-row');
    if (this.mode === 'easy') {
      row.append(
        this.field(
          'Tap (short press)',
          this.valueSelect(this.tap, (v) => {
            this.tap = v;
          }),
        ),
      );
      row.append(
        this.field(
          'Hold (long press)',
          this.valueSelect(this.hold, (v) => {
            this.hold = v;
          }),
        ),
      );
    } else {
      row.append(
        this.field(
          'Tap value (raw u32)',
          this.rawValueInput(this.tap, this.tapRaw, (s) => { this.tapRaw = s; }, (v) => { this.tap = v; }),
        ),
      );
      row.append(
        this.field(
          'Hold value (raw u32)',
          this.rawValueInput(this.hold, this.holdRaw, (s) => { this.holdRaw = s; }, (v) => { this.hold = v; }),
        ),
      );
    }
    const time = this.el('input', 'macro-num') as HTMLInputElement;
    time.type = 'number';
    time.min = '0';
    time.max = String(MT_TIME_MAX_MS);
    time.step = '10';
    time.value = String(this.holdMs);
    const unitText = (): string => {
      const u = mtUnitsFromMs(this.holdMs);
      return u === null ? 'invalid' : `${u} × 10 ms`;
    };
    time.title = `Hold threshold in ms (0–${MT_TIME_MAX_MS}), rounded to 10 ms steps — wire value = ${unitText()}`;
    time.addEventListener('input', () => {
      this.holdMs = Number(time.value);
      time.title = `Hold threshold in ms (0–${MT_TIME_MAX_MS}), rounded to 10 ms steps — wire value = ${unitText()}`;
    });
    row.append(this.field('Hold time (ms)', time));
    wrap.append(row);
    wrap.append(
      this.el(
        'p',
        'hint',
        'A short press does the Tap action; pressing longer than the threshold does the Hold action.',
      ),
    );
    wrap.append(this.advApplyButton(ctx));
    host.append(wrap);
  }

  /** Partner/target slot <select> over arg-0 keymap indices (easy mode). */
  private slotSelect(
    current: number | null,
    exclude: number,
    ctx: ConfigureContext,
    onPick: (i: number) => void,
  ): HTMLSelectElement {
    const sel = this.el('select', 'macro-select beh-select') as HTMLSelectElement;
    // Committed arg-0 values — used only to keep opaque (unknown-tag)
    // slots out of the picker (§Safety 7). When the decode cache is not
    // populated yet every slot is listed; the write-time diff check in
    // commitAdv still refuses to overwrite an opaque slot.
    const km = app.snapshot?.keymaps.get(0);
    for (let i = 0; i < KEYMAP_ENTRIES; i++) {
      if (i === exclude) continue;
      const v = km?.[i]?.value;
      if (v !== undefined && isOpaqueKeymapValue(v >>> 0)) continue;
      const o = this.el('option', '', `Key ${i} — ${ctx.labelFor(i) || '(empty)'}`) as HTMLOptionElement;
      o.value = String(i);
      sel.append(o);
    }
    if (current !== null && current !== exclude) sel.value = String(current);
    else if (sel.options.length > 0) sel.value = sel.options[0]?.value ?? '';
    sel.addEventListener('change', () => onPick(Number(sel.value)));
    return sel;
  }

  private directionSelect(): HTMLSelectElement {
    const sel = this.el('select', 'macro-select beh-select') as HTMLSelectElement;
    SOCD_DIRECTION_LABELS.forEach((label, i) => {
      const o = this.el('option', '', this.mode === 'advanced' ? `${i} — ${label}` : label) as HTMLOptionElement;
      o.value = String(i);
      sel.append(o);
    });
    sel.value = String(this.direction);
    sel.addEventListener('change', () => {
      this.direction = Number(sel.value);
    });
    return sel;
  }

  private renderSocdForm(host: HTMLElement, ctx: ConfigureContext): void {
    // The partner must differ from the configured key — reseat it when
    // the selection moved (or it was never picked).
    if (this.partner === null || this.partner === ctx.index || this.partner >= KEYMAP_ENTRIES) {
      this.partner = ctx.index === 0 ? 1 : 0;
      this.partnerRaw = String(this.partner);
    }
    const wrap = this.el('div', 'beh-form');
    const row = this.el('div', 'macro-bind-row');
    const arg0 = ctx.arg === 0;
    if (this.mode === 'easy') {
      row.append(
        this.field(
          'Other key (B)',
          arg0
            ? this.slotSelect(this.partner, ctx.index, ctx, (i) => {
                this.partner = i;
                this.partnerRaw = String(i);
              })
            : this.disabledSelect('only on User key set 1'),
        ),
      );
      row.append(this.field('When both are pressed', this.directionSelect()));
    } else {
      row.append(
        this.field(
          'Key B (keymap index)',
          this.rawIndexInput(this.partner, this.partnerRaw, (s) => { this.partnerRaw = s; }, (v) => { this.partner = v; }),
        ),
      );
      row.append(this.field('Direction (0–3)', this.directionSelect()));
    }
    wrap.append(row);
    wrap.append(
      this.el(
        'p',
        'hint',
        'This key is key A. The two keys share opposing directions; the direction picks what happens when both are pressed at once.',
      ),
    );
    wrap.append(this.advApplyButton(ctx));
    host.append(wrap);
  }

  private renderTglForm(host: HTMLElement, ctx: ConfigureContext): void {
    if (this.target === null || this.target === ctx.index || this.target >= KEYMAP_ENTRIES) {
      this.target = ctx.index === 0 ? 1 : 0;
      this.targetRaw = String(this.target);
    }
    const wrap = this.el('div', 'beh-form');
    const row = this.el('div', 'macro-bind-row');
    const arg0 = ctx.arg === 0;
    if (this.mode === 'easy') {
      row.append(
        this.field(
          'Key to toggle',
          arg0
            ? this.slotSelect(this.target, ctx.index, ctx, (i) => {
                this.target = i;
                this.targetRaw = String(i);
              })
            : this.disabledSelect('only on User key set 1'),
        ),
      );
    } else {
      row.append(
        this.field(
          'Toggle target (keymap index)',
          this.rawIndexInput(this.target, this.targetRaw, (s) => { this.targetRaw = s; }, (v) => { this.target = v; }),
        ),
      );
    }
    wrap.append(row);
    wrap.append(
      this.el('p', 'hint', 'Each press of this key switches the other key\u2019s action on or off.'),
    );
    wrap.append(this.advApplyButton(ctx));
    host.append(wrap);
  }

  private disabledSelect(reason: string): HTMLSelectElement {
    const sel = this.el('select', 'macro-select beh-select') as HTMLSelectElement;
    sel.disabled = true;
    const o = this.el('option', '', reason) as HTMLOptionElement;
    o.value = '';
    sel.append(o);
    return sel;
  }

  private rawIndexInput(
    current: number | null,
    raw: string,
    onRaw: (s: string) => void,
    onPick: (v: number | null) => void,
  ): HTMLInputElement {
    const input = this.el('input', 'macro-num beh-raw') as HTMLInputElement;
    input.type = 'text';
    input.inputMode = 'numeric';
    input.value = raw !== '' ? raw : current === null ? '' : String(current);
    input.placeholder = 'keymap index 0–127';
    input.title = 'Keymap slot index (0–127), same numbering as the keys list';
    input.addEventListener('input', () => {
      onRaw(input.value);
      const t = input.value.trim();
      const v = /^[0-9]{1,3}$/.test(t) ? Number(t) : null;
      const ok = v !== null && v >= 0 && v < KEYMAP_ENTRIES;
      onPick(ok ? v : null);
      input.classList.toggle('beh-invalid', !ok);
    });
    return input;
  }

  // ── Apply (immediate adv write) ─────────────────────────────────────

  /** Build the current adv draft, or an error string. */
  private buildDraft(ctx: ConfigureContext): { draft?: AdvDraft; error?: string } {
    switch (this.choice) {
      case 'mt': {
        const units = mtUnitsFromMs(this.holdMs);
        if (units === null) return { error: `hold time must be 0–${MT_TIME_MAX_MS} ms` };
        if (this.tap === null || this.hold === null) {
          return { error: 'tap and hold values are required (empty is not a key)' };
        }
        return {
          draft: { kind: 'mt', tap: this.tap >>> 0, hold: this.hold >>> 0, timeUnits: units },
        };
      }
      case 'socd': {
        if (this.partner === null) return { error: 'pick the other key (B)' };
        return {
          draft: { kind: 'socd', keyA: ctx.index, keyB: this.partner, direction: this.direction },
        };
      }
      case 'tgl': {
        if (this.target === null) return { error: 'pick the key to toggle' };
        return { draft: { kind: 'tgl', key: ctx.index, target: this.target } };
      }
      default:
        return { error: 'pick an advanced behavior first' };
    }
  }

  /**
   * Shared Apply button + notes for adv behaviors. The write happens
   * immediately after confirm — the label and dialog both say so.
   */
  private advApplyButton(ctx: ConfigureContext): HTMLElement {
    const wrap = this.el('div', 'beh-apply');
    const conflict = this.stagedConflict(ctx);
    const stagedN = ctx.stagedCount();

    const notes: string[] = [];
    const opt = this.optionFor(this.choice);
    if (opt?.caveat) notes.push(opt.caveat);
    if (conflict.length > 0) {
      notes.push(
        `Blocked: key${conflict.length === 1 ? '' : 's'} ${conflict.join(', ')} ` +
          'have unsaved staged edits — save or discard them first (the advanced ' +
          'write sends the keyboard\u2019s saved values, not your staged edits).',
      );
    } else if (stagedN > 0) {
      notes.push(
        `${stagedN} key edit(s) stay staged on User key set 1 — saving them later ` +
          'overwrites whatever is on those keys, including advanced bindings.',
      );
    }
    for (const n of notes) wrap.append(this.el('p', 'hint warn', n));

    const go = this.el(
      'button',
      'btn btn-primary beh-apply-btn',
      'Save to keyboard now',
    ) as HTMLButtonElement;
    go.type = 'button';
    go.disabled = this.busy || ctx.arg !== 0 || conflict.length > 0 || !opt?.available;
    go.title = 'Writes to the keyboard immediately — NOT part of the staged Save flow';
    go.addEventListener('click', () => void this.applyAdv(ctx));
    wrap.append(go);
    return wrap;
  }

  private async applyAdv(ctx: ConfigureContext): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot) return;
    const opt = this.optionFor(this.choice);
    if (!opt?.available) {
      setStatus(opt?.reason ?? 'This behavior is not available on the connected device.', true);
      return;
    }
    if (ctx.arg !== 0) {
      setStatus('Advanced functions only exist on User key set 1 — switch to that tab first.', true);
      return;
    }
    const built = this.buildDraft(ctx);
    if (built.error || !built.draft) {
      setStatus(built.error ?? 'fill in every field first', true);
      return;
    }
    const draft = built.draft;
    const invalid = validateAdvDraft(draft);
    if (invalid) {
      setStatus(`Cannot configure that: ${invalid}`, true);
      return;
    }
    // Staged-edit conflict on bound slots.
    const conflict = this.stagedConflict(ctx);
    if (conflict.length > 0) {
      setStatus(
        `Key${conflict.length === 1 ? '' : 's'} ${conflict.join(', ')} have unsaved staged edits — save or discard them first.`,
        true,
      );
      return;
    }
    const adv = await this.ensureAdv();
    if (!adv) {
      setStatus(
        this.advError
          ? `Could not read advanced-key settings: ${this.advError}`
          : 'Advanced-key settings unavailable — try again.',
        true,
      );
      return;
    }

    const desc = describeAdvDraft(
      draft,
      ctx.index,
      (i) => `key ${i} (${ctx.labelFor(i) || 'unnamed'})`,
      (v) => behaviorValueLabel(v) || `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    );
    const caveat = opt.caveat;
    const stagedN = ctx.stagedCount();
    const ok = await confirmDialog({
      title: `${desc}?`,
      bodyText:
        'This writes to the keyboard IMMEDIATELY — it is not part of the staged ' +
        '"Save" flow on this page. Only this key\u2019s advanced function changes; ' +
        'the rest of the keymap is untouched.',
      details: [
        ...(caveat ? [`Caveat: ${caveat}`] : []),
        ...(stagedN > 0
          ? [`${stagedN} unsaved key edit(s) remain staged on User key set 1.`]
          : []),
      ],
      hint:
        'The key binding is checked on the keyboard; the settings blob is ' +
        'verified only when this firmware allows it.',
      impact: {
        affected: [`Advanced function on key ${ctx.index}`],
        persistent: true,
        backupCaptured: true,
        // Adv settings blobs are not a restorable profile-history
        // section — only the keymap slot itself rolls back.
        rollback: 'partial',
        restartRisk: false,
      },
      confirmLabel: 'Save to keyboard now',
    });
    if (!ok || this.busy) return;
    await this.commitAdv(ctx, draft, adv, desc);
  }

  /**
   * The device-write half of `applyAdv` (post-confirm): plan, guard the
   * whole-table keymap write (§Safety 6/7), send the vendor-order writes
   * and refresh the caches. Kept free of the confirm dialog so the guard
   * paths are unit-testable with a mocked session.
   */
  private async commitAdv(
    ctx: ConfigureContext,
    draft: AdvDraft,
    adv: AdvCache,
    desc: string,
  ): Promise<void> {
    if (!app.connected || !app.snapshot) return;
    let plan: AdvPlan;
    try {
      const km = adv.keymap;
      const blob = adv.blob;
      switch (draft.kind) {
        case 'mt':
          plan = planMt(blob, km, ctx.index, draft.tap, draft.hold, draft.timeUnits);
          break;
        case 'socd':
          plan = planSocd(blob, km, ctx.index, draft.keyB, draft.direction);
          break;
        case 'tgl':
          plan = planTgl(blob, km, ctx.index, draft.target);
          break;
      }
    } catch (e) {
      setStatus(
        `Could not set up that advanced key: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
      return;
    }

    this.busy = true;
    const s = app.connected.session;
    try {
      // §Safety 6 — `plan.keymap` is a whole-table write; refuse to send
      // one that is empty/short/corrupt or that does not match the
      // guarded base it was planned on.
      const km = guardKeymapBase(plan.keymap, { arg: 0, expectedLen: adv.keymap.length });
      // §Safety 7 — a plan may only rewrite slots whose previous value
      // is known or empty; an opaque (unknown-tag) slot must survive
      // byte-identical, so any plan that changes one is refused here
      // even if it slipped past the pickers (same diff check as
      // advkeys.ts applyPlan).
      for (let i = 0; i < km.length; i++) {
        const before = adv.keymap[i];
        if (before !== undefined && km[i] !== before && isOpaqueKeymapValue(before)) {
          throw new Error(
            `key ${i} holds a value this app does not recognize — refusing to overwrite it`,
          );
        }
      }
      // TGL stores the target's *value* in the history blob rather than
      // rewriting its keymap slot — still refuse an opaque target so an
      // unrecognized value is never captured into a binding.
      if (draft.kind === 'tgl') {
        const tv = adv.keymap[draft.target];
        if (tv !== undefined && isOpaqueKeymapValue(tv)) {
          throw new Error(
            `key ${draft.target} holds a value this app does not recognize — refusing to bind it`,
          );
        }
      }
      // Vendor order: keymap binding first (cmd 3, 0/2 channel), then the
      // history blob (cmd 18) — same as advkeys.ts / `omg kb916 adv set`.
      await s.writeKeyConfiguration(km);
      const ho = await s.writeAdvKeyConfig(plan.blob);

      // Refresh what we can trust (same bookkeeping as AdvPage). The
      // read-back seeds the next write's base, so it passes the same
      // guard pinned to the length just verified on the wire; an
      // untrusted read-back drops the cache instead of keeping it.
      const back = await s.keyValues(0).catch(() => null);
      if (back && this.adv) {
        try {
          this.adv.keymap = guardKeymapBase(back.map((v) => v >>> 0), {
            arg: 0,
            expectedLen: km.length,
          });
        } catch {
          this.adv = null;
        }
      }
      if (this.adv) this.adv.blob = plan.blob;
      app.snapshot.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});
      ctx.onDeviceWrite();

      const hist = ho.verified
        ? 'settings saved and checked'
        : 'settings sent but NOT confirmed (this firmware may not keep them — check the Advanced page in a minute)';
      setStatus(`${desc} — key binding saved; ${hist}.`);
      emit();
    } catch (e) {
      setStatus(
        `Could not save the advanced-key change: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
      void this.ensureAdv(true);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Remove an existing adv binding: overwrite the slot with 0 through
   * the normal cmd-3 keymap write (same as `omg kb916 set key <i> 0`).
   * The history entry stays — the device has no delete.
   */
  private async removeAdv(ctx: ConfigureContext): Promise<void> {
    if (this.busy || !app.connected || !app.snapshot || ctx.arg !== 0) return;
    if (ctx.hasStaged(ctx.index)) {
      setStatus('This key has an unsaved staged change — save or discard it first.', true);
      return;
    }
    const summary = currentBehaviorSummary(ctx.committed) ?? 'an advanced function';
    const ok = await confirmDialog({
      title: `Remove ${summary} from key ${ctx.index}?`,
      bodyText:
        'This writes 0 to that one key position NOW and checks the write. ' +
        'The saved settings stay stored on the keyboard (the device has no delete).',
      impact: {
        affected: [`Advanced function on key ${ctx.index}`],
        persistent: true,
        backupCaptured: true,
        rollback: 'partial',
        restartRisk: false,
      },
      confirmLabel: 'Remove function',
      danger: true,
    });
    if (!ok) return;
    await this.commitRemoveAdv(ctx);
  }

  /**
   * The device-write half of `removeAdv` (post-confirm). Rebuilds the
   * whole-table write from a FRESH guarded read (`keymapBase` →
   * `guardKeymapBase`, §Safety 6) — never the cached decode padded with
   * zeros — and refuses to zero an opaque unknown-tag slot (§Safety 7).
   * Kept free of the confirm dialog so the guard paths are
   * unit-testable with a mocked session.
   */
  private async commitRemoveAdv(ctx: ConfigureContext): Promise<void> {
    if (!app.connected || !app.snapshot || ctx.arg !== 0) return;
    this.busy = true;
    try {
      app.snapshot.keymaps.delete(0);
      const base = guardKeymapBase(await keymapBase(0), {
        arg: 0,
        expectedLen: this.adv?.keymap.length,
      });
      if (ctx.index >= base.length) {
        throw new Error(
          `key ${ctx.index} is past the ${base.length} keys the keyboard reports — nothing was sent`,
        );
      }
      const before = base[ctx.index] ?? 0;
      if (isOpaqueKeymapValue(before)) {
        throw new Error(
          `key ${ctx.index} holds a value this app does not recognize — refusing to overwrite it`,
        );
      }
      const values = base.slice();
      while (values.length < KEYMAP_ENTRIES) values.push(0);
      values[ctx.index] = 0;
      await app.connected.session.writeKeymap(0, 0, values);
      app.snapshot?.keymaps.delete(0);
      void ensureKeymap(0).catch(() => {});
      // The binding is gone but the blob is unchanged; drop the cache so
      // a later configure re-reads fresh state.
      this.adv = null;
      ctx.onDeviceWrite();
      setStatus(`Removed the advanced function from key ${ctx.index} — checked on the keyboard.`);
      emit();
    } catch (e) {
      setStatus(
        `Could not remove that function: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    } finally {
      this.busy = false;
    }
  }

  // ── Unavailable section ─────────────────────────────────────────────

  private renderUnavailable(host: HTMLElement): void {
    // Only the always-unavailable inventory behaviors — capability-gated
    // adv options already render as disabled radios with their reason.
    const missing = this.catalog().filter((o) => o.group === 'unavailable');
    if (missing.length === 0) return;
    const det = this.el('details', 'beh-unavailable');
    det.append(this.el('summary', '', `Not available on this keyboard (${missing.length})`));
    const ul = this.el('ul', 'beh-unavailable-list');
    for (const opt of missing) {
      const li = this.el('li', '');
      li.append(this.el('span', 'beh-unavailable-name', opt.label));
      li.append(this.el('span', 'hint', opt.reason ?? 'not supported'));
      ul.append(li);
    }
    det.append(ul);
    host.append(det);
  }
}
