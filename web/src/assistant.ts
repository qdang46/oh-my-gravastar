/**
 * AI Assistant page — bead oh-my-gravastar-7js PART 2.
 *
 * Chat-style NL → plan → preview → apply UI on top of the agent engine
 * (`web/src/agent/*`, docs/agent-api.md):
 *
 *   input ──parseIntent──▶ understood / questions / unsupported
 *        ──lowerOpInputs──▶ planFromOps ──▶ simulatePlan + buildDryRunReport
 *        ──confirmDialog──▶ snapshotBeforeWrite ──▶ executePlan
 *
 * Safety contract (AGENTS.md §2): nothing is sent before the preview is
 * shown AND the user confirms the dialog; every write goes through
 * `executePlan` → `runTransaction` (policy classes, journal, read-back
 * verification). A pre-write `SnapshotStore` backup is taken first,
 * matching the profile-import path. Applies are refused while the
 * session's write gate is closed (`writesBlocked` after a silent
 * reconnect — R6).
 *
 * DOM logic lives here; all pure logic (lowering, descriptions, chips,
 * capability hints) is in `assistant-core.ts` and unit-tested under
 * Node (`scripts/test-assistant.ts`).
 */

import { app, connect, refresh } from './state.ts';
import { formatVidPid } from './hid.ts';
import { confirmDialog } from './modal.ts';
import {
  buildDeviceContext,
  buildDryRunReport,
  executePlan,
  parseIntent,
  planFromOps,
  simulatePlan,
  type DeviceContext,
  type ExecuteResult,
  type IntentContext,
} from './agent/index.ts';
import {
  describeOpInput,
  lowerOpInputs,
  possibleFeatures,
  questionChips,
  type QuestionChip,
} from './assistant-core.ts';
import { getCapabilities, type DeviceLike } from './core/index.ts';
import { SnapshotStore, snapshotBeforeWrite } from './safety/index.ts';
import type { Khub916Session } from './hid.ts';

// ── DOM helpers (same style as pages.ts) ───────────────────────────────

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

// ── Device context (cached per session) ────────────────────────────────

/**
 * The agent pipeline wants a full `DeviceContext` (capabilities, layout,
 * keymaps, macros, snapshots). `buildDeviceContext` costs ~10 sequential
 * feature reports, so it is built lazily on the first request and cached
 * per session; an apply invalidates it (device state changed).
 */
let ctxCache: { session: Khub916Session; ctx: DeviceContext } | null = null;

async function deviceContext(): Promise<DeviceContext | null> {
  const c = app.connected;
  if (!c) return null;
  if (ctxCache?.session === c.session) return ctxCache.ctx;
  const store = new SnapshotStore();
  const device: DeviceLike = {
    vendorId: c.device.vendorId,
    productId: c.device.productId,
    productName: c.device.productName ?? null,
  };
  const ctx = await buildDeviceContext(c.session, { device, snapshots: store });
  ctxCache = { session: c.session, ctx };
  return ctx;
}

function intentContext(ctx: DeviceContext | null): IntentContext {
  if (!ctx) return { deviceSelector: 'auto' };
  return {
    deviceSelector: 'auto',
    capabilities: ctx.capabilities,
    ...(ctx.layout ? { layout: ctx.layout } : {}),
    keymaps: ctx.keymaps,
    snapshots: ctx.snapshots,
    macros: ctx.macros,
  };
}

// ── Page ───────────────────────────────────────────────────────────────

class AssistantView {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly sessionBar: HTMLElement;
  private busy = false;
  private destroyed = false;

  constructor(root: HTMLElement) {
    this.el = el('div', 'assistant');

    this.sessionBar = el('div', 'assistant-session');
    this.el.append(this.sessionBar);

    this.log = el('div', 'assistant-log');
    this.el.append(this.log);

    const form = el('form', 'assistant-form') as HTMLFormElement;
    this.input = el('input', 'assistant-input') as HTMLInputElement;
    this.input.type = 'text';
    this.input.placeholder =
      'Ask in English or Vietnamese — e.g. "caps lock thành ctrl", "đèn đỏ", "macro ghi hello"';
    this.input.autocomplete = 'off';
    this.sendBtn = el('button', 'btn btn-primary', 'Send') as HTMLButtonElement;
    this.sendBtn.type = 'submit';
    form.append(this.input, this.sendBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit(this.input.value);
    });
    this.el.append(form);

    root.append(this.el);
    this.syncChrome();
    this.addBot(
      'Hi! Tell me what to change — key remaps, lighting, macros, advanced keys ' +
        '(SOCD / mod-tap / toggle), sleep timer or snapshot restores. I show a ' +
        'preview first; nothing is sent until you confirm.',
      'assistant-intro',
    );
    if (!app.connected) this.showConnectPrompt();
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Re-sync the session strip + composer state (called on every state emit). */
  syncChrome(): void {
    if (this.destroyed) return;
    this.sessionBar.replaceChildren();
    const c = app.connected;
    if (!c) {
      const p = el('p', 'hint', 'No keyboard connected — the assistant needs a device to plan against.');
      const btn = el('button', 'btn btn-primary', 'Connect keyboard');
      btn.type = 'button';
      btn.addEventListener('click', () => void connect());
      this.sessionBar.append(p, btn);
      this.sendBtn.disabled = true;
      this.input.disabled = true;
      return;
    }
    const writesBlocked = c.session.writesBlocked || app.reconnectedSilently;
    const parts = [
      el('span', 'assistant-device', app.deviceLabel || c.device.productName || 'Keyboard'),
      el('span', 'hint', `${formatVidPid(c.device)} · ${writesBlocked ? 'changes blocked — reconnect to edit' : 'ready'}`),
    ];
    this.sessionBar.append(...parts);
    this.sendBtn.disabled = this.busy;
    this.input.disabled = this.busy;
  }

  private showConnectPrompt(): void {
    const card = el('div', 'agent-card agent-empty');
    card.append(
      el('p', '', 'Connect your GravaStar keyboard to use the assistant.'),
      el('p', 'hint', 'Once connected I can read its layout, capabilities and current settings.'),
    );
    this.log.append(card);
  }

  // ── Chat rendering ──────────────────────────────────────────────────

  private addUser(text: string): void {
    const bubble = el('div', 'agent-msg agent-user');
    bubble.append(el('p', 'agent-text', text));
    this.log.append(bubble);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private addBot(text: string, className = 'agent-msg agent-bot'): HTMLElement {
    const bubble = el('div', className);
    bubble.append(el('p', 'agent-text', text));
    this.log.append(bubble);
    this.log.scrollTop = this.log.scrollHeight;
    return bubble;
  }

  /** A structured bot card (plan / result / error details). */
  private addCard(className: string): { card: HTMLElement; body: HTMLElement } {
    const card = el('div', `agent-card ${className}`);
    const body = el('div', 'agent-card-body');
    card.append(body);
    this.log.append(card);
    this.log.scrollTop = this.log.scrollHeight;
    return { card, body };
  }

  private listLines(parent: HTMLElement, items: string[], className = ''): void {
    if (items.length === 0) return;
    const ul = el('ul', `agent-list ${className}`.trim());
    for (const item of items) ul.append(el('li', '', item));
    parent.append(ul);
  }

  // ── Submit pipeline ─────────────────────────────────────────────────

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.addUser(text);
    this.busy = true;
    this.syncChrome();
    try {
      await this.run(text);
    } catch (e) {
      this.addBot(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`, 'agent-msg agent-bot agent-error');
    } finally {
      this.busy = false;
      this.syncChrome();
    }
  }

  private async run(text: string): Promise<void> {
    const c = app.connected;
    if (!c) {
      this.addBot('No keyboard is connected — press Connect first.');
      return;
    }

    // Device context is needed for capability gating + name resolution.
    // A failed context degrades to schema-only parsing (questions, not
    // guesses) — never blocks the chat.
    let ctx: DeviceContext | null = null;
    try {
      ctx = await deviceContext();
    } catch (e) {
      this.addBot(
        `Could not read the keyboard's details (${e instanceof Error ? e.message : String(e)}) — ` +
          'I can still try, but layout-dependent requests may need clarification.',
        'agent-msg agent-bot agent-warn',
      );
    }

    const intent = parseIntent(text, intentContext(ctx));
    this.renderIntent(intent, ctx, text);

    if (intent.ops.length === 0) return;

    // Lower OpInput drafts → schema ops. Problems block the plan.
    const lowered = lowerOpInputs(intent.ops, {
      ...(ctx?.layout ? { layout: ctx.layout } : {}),
      snapshots: ctx?.snapshots ?? [],
    });
    if (lowered.problems.length > 0) {
      const { body } = this.addCard('agent-plan agent-blocked');
      body.append(el('h3', 'agent-plan-title', 'Cannot build a plan'));
      this.listLines(body, lowered.problems, 'agent-errors');
      return;
    }
    if (lowered.ops.length === 0) return;

    const plan = planFromOps(lowered.ops, ctx ?? undefined);
    const sim = simulatePlan(plan, ctx ?? undefined);
    const report = buildDryRunReport(plan, {
      ...(ctx ? { context: ctx } : {}),
      snapshots: new SnapshotStore(),
    });
    this.renderPlan(plan, sim, report, ctx);
  }

  // ── Rendering stages ────────────────────────────────────────────────

  private renderIntent(
    intent: ReturnType<typeof parseIntent>,
    ctx: DeviceContext | null,
    request: string,
  ): void {
    if (intent.understood.length === 0 && intent.questions.length === 0 &&
        intent.unsupported.length === 0 && intent.ops.length === 0) {
      return;
    }
    const { body } = this.addCard('agent-intent');

    if (intent.ops.length > 0) {
      body.append(el('h3', 'agent-plan-title', 'I understood:'));
      const ul = el('ul', 'agent-ops');
      for (const op of intent.ops) ul.append(el('li', '', describeOpInput(op)));
      body.append(ul);
      // Context notes the parser attached (e.g. "available but
      // unverified — …") — the op summaries themselves are covered by
      // describeOpInput above, so only non-summary notes are repeated.
      const isOpSummary = (u: string): boolean =>
        /^(keymap|lighting|macro|restore|sleep|socd|mt |tgl|interpreter)/i.test(u);
      for (const n of intent.understood.filter((u) => !isOpSummary(u))) {
        body.append(el('p', 'hint', n));
      }
    } else if (intent.understood.length > 0) {
      this.listLines(body, intent.understood);
    }
    if (intent.unsupported.length > 0) {
      body.append(el('h3', 'agent-plan-title agent-unsupported-title', "Can't do that on this keyboard"));
      this.listLines(body, intent.unsupported, 'agent-unsupported');
      const caps = ctx?.capabilities ?? getCapabilities(this.deviceLike());
      const possible = possibleFeatures(caps);
      if (possible.length > 0) {
        body.append(el('p', 'hint', 'What I CAN do here:'));
        this.listLines(body, possible);
      } else {
        body.append(
          el('p', 'hint', 'Connect the keyboard so I can check its capabilities.'),
        );
      }
    }
    if (intent.questions.length > 0) {
      body.append(el('h3', 'agent-plan-title', 'Need a detail:'));
      for (const q of intent.questions) {
        body.append(el('p', 'agent-question', q));
        const chips = questionChips(q, {
          snapshots: ctx?.snapshots,
          macros: ctx?.macros,
        });
        if (chips.length > 0) {
          const row = el('div', 'agent-chips');
          for (const chip of chips) row.append(this.chipButton(chip, request));
          body.append(row);
        }
      }
    }
    if (intent.ops.length === 0 && intent.unsupported.length === 0 && intent.questions.length === 0) {
      body.append(el('p', 'hint', 'Nothing to do.'));
    }
  }

  private chipButton(chip: QuestionChip, request: string): HTMLButtonElement {
    const btn = el('button', 'agent-chip', chip.label) as HTMLButtonElement;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      // Chips refine the ORIGINAL request; re-run the whole pipeline.
      this.input.value = `${request} ${chip.append}`;
      void this.submit(this.input.value);
    });
    return btn;
  }

  private deviceLike(): DeviceLike {
    const c = app.connected;
    if (!c) return {};
    return {
      vendorId: c.device.vendorId,
      productId: c.device.productId,
      productName: c.device.productName ?? null,
    };
  }

  private renderPlan(
    plan: ReturnType<typeof planFromOps>,
    sim: ReturnType<typeof simulatePlan>,
    report: ReturnType<typeof buildDryRunReport>,
    ctx: DeviceContext | null,
  ): void {
    const { card, body } = this.addCard('agent-plan');
    card.dataset.planId = plan.plan_id;

    body.append(el('h3', 'agent-plan-title', `Plan — ${plan.ops.length} change(s)`));

    // Policy badges + per-op diff lines.
    const ul = el('ul', 'agent-ops agent-plan-ops');
    plan.ops.forEach((pop) => {
      const li = el('li', 'agent-plan-op');
      li.append(el('span', `agent-badge agent-badge-${pop.policy.class.toLowerCase()}`, pop.policy.class));
      li.append(el('span', 'agent-op-diff', pop.diff));
      ul.append(li);
    });
    body.append(ul);

    // Before→after detail from the simulator (key labels, lighting…).
    if (sim.simulation.summary.length > 0) {
      body.append(el('h4', 'agent-subtitle', 'What changes'));
      this.listLines(body, sim.simulation.summary, 'agent-diff');
    }
    if (sim.simulation.affectedKeys > 0) {
      body.append(
        el('p', 'hint', `${sim.simulation.affectedKeys} key position(s) affected.`),
      );
    }

    // Predicted device writes (dry-run report) — the "exact change" list.
    if (report.totals.writes > 0) {
      body.append(el('h4', 'agent-subtitle', `Device writes (${report.totals.writes})`));
      const wul = el('ul', 'agent-writes');
      for (const op of report.ops) {
        for (const w of op.writes) {
          const li = el('li', '');
          li.append(el('code', 'agent-method', w.method));
          li.append(document.createTextNode(` — ${w.detail}`));
          wul.append(li);
        }
      }
      body.append(wul);
      if (report.totals.bytes !== undefined) {
        body.append(el('p', 'hint', `≈ ${report.totals.bytes} bytes on the wire.`));
      }
    }

    // Warnings / errors.
    const warnings = [...new Set([...plan.warnings, ...sim.validation.warnings, ...report.validation.warnings])];
    const errors = [...new Set([...plan.errors, ...sim.validation.errors, ...report.validation.errors])];
    if (warnings.length > 0) {
      body.append(el('h4', 'agent-subtitle agent-warn-title', 'Warnings'));
      this.listLines(body, warnings, 'agent-warnings');
    }
    if (errors.length > 0) {
      body.append(el('h4', 'agent-subtitle agent-error-title', 'Problems — this plan cannot run'));
      this.listLines(body, errors, 'agent-errors');
    }

    const canApply =
      plan.valid &&
      sim.validation.ok &&
      report.ok &&
      errors.length === 0 &&
      !this.writesBlocked();

    const row = el('div', 'agent-actions');
    const applyBtn = el('button', 'btn btn-primary', 'Preview & apply…') as HTMLButtonElement;
    applyBtn.type = 'button';
    applyBtn.disabled = !canApply;
    applyBtn.addEventListener('click', () => void this.apply(plan, sim, ctx));
    row.append(applyBtn);
    if (this.writesBlocked()) {
      row.append(
        el('p', 'hint warn',
          'Changes are paused after an automatic reconnect — press Disconnect, then Connect, to re-approve this device.'),
      );
    } else if (errors.length > 0 || !plan.valid || !sim.validation.ok) {
      row.append(el('p', 'hint', 'Fix the problems above before applying.'));
    } else {
      row.append(el('p', 'hint', 'Nothing is sent until you confirm the next dialog.'));
    }
    body.append(row);
  }

  private writesBlocked(): boolean {
    const c = app.connected;
    return !c || c.session.writesBlocked || app.reconnectedSilently;
  }

  // ── Apply ───────────────────────────────────────────────────────────

  private async apply(
    plan: ReturnType<typeof planFromOps>,
    sim: ReturnType<typeof simulatePlan>,
    ctx: DeviceContext | null,
  ): Promise<void> {
    const c = app.connected;
    if (!c || this.writesBlocked()) return;

    const details = [
      ...plan.diffSummary,
      '',
      ...sim.simulation.writeOrder.map((w) => `writes: ${w}`),
    ];
    const ok = await confirmDialog({
      title: `Apply ${plan.ops.length} change(s) to ${app.deviceLabel || 'the keyboard'}?`,
      bodyText:
        'Every change is written to the keyboard and verified by read-back. ' +
        'A backup of the current settings is saved first so you can restore it.',
      details,
      confirmLabel: 'Apply changes',
      cancelLabel: 'Cancel',
    });
    if (!ok || this.destroyed) return;

    this.busy = true;
    this.syncChrome();
    try {
      const store = new SnapshotStore();
      // SAFETY-SPEC §5: never write without a restore point — abort on
      // snapshot failure, same as the profile-import path.
      let backupNote = '';
      try {
        const snap = await snapshotBeforeWrite(store, c.session, 'Assistant apply');
        backupNote = ` Backup ${snap.id} saved.`;
      } catch (e) {
        this.addBot(
          `Aborted before any write — could not save a backup: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`,
          'agent-msg agent-bot agent-error',
        );
        return;
      }

      const result: ExecuteResult = await executePlan(plan, {
        session: c.session,
        context: ctx ?? undefined,
        snapshots: store,
        // The confirm dialog above IS the L2 approval for this plan.
        approve: () => true,
      });
      this.renderResult(result, backupNote);
      // Device state changed — drop the cached context and re-read the
      // app snapshot so the rest of the UI stays honest.
      ctxCache = null;
      void refresh();
    } finally {
      this.busy = false;
      this.syncChrome();
    }
  }

  private renderResult(result: ExecuteResult, backupNote: string): void {
    const { body } = this.addCard(result.ok ? 'agent-result agent-ok' : 'agent-result agent-error');
    body.append(
      el(
        'h3',
        'agent-plan-title',
        result.ok
          ? `Applied — ${result.applied.length} change(s)${result.verified ? ', all verified' : ''}`
          : `Stopped — ${result.failed ?? 'plan refused'}`,
      ),
    );
    if (backupNote) body.append(el('p', 'hint', backupNote.trim()));

    if (result.tx) {
      const ul = el('ul', 'agent-results');
      for (const j of result.tx.journal) {
        const li = el('li', `agent-result-row agent-result-${j.result}`);
        li.append(el('span', 'agent-result-badge', j.result));
        li.append(el('span', '', j.label ?? j.op));
        if (j.error) li.append(el('span', 'hint warn', ` — ${j.error}`));
        ul.append(li);
      }
      body.append(ul);
    }
    if (result.errors.length > 0) {
      this.listLines(body, result.errors, 'agent-errors');
    }
    if (result.verified === false && result.ok) {
      body.append(
        el('p', 'hint warn',
          'Some writes were sent but the keyboard did not confirm them — check the device before retrying.'),
      );
    }
  }
}

// ── Mount / unmount (stateful — survives state emits) ─────────────────

let page: AssistantView | null = null;

/**
 * Renderer for pages.ts. The view is stateful (chat history), so it is
 * created once per mount; `syncChrome` refreshes the session strip on
 * every state emit without wiping the conversation.
 */
export function renderAssistantPage(root: HTMLElement): void {
  if (page && page.el.isConnected) {
    page.syncChrome();
    return;
  }
  page?.destroy();
  page = new AssistantView(root);
}

export function destroyAssistantPage(): void {
  page?.destroy();
  page = null;
  ctxCache = null;
}
