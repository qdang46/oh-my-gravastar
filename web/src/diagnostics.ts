/**
 * Diagnostics — L0 read-only health page (docs/UIUX-SPEC.md §2.7,
 * bead `oq2`).
 *
 * Sections:
 *
 *   - Connection quality: transport/session state straight from
 *     `Khub916Session` (poison reason, write gate, silent reconnect)
 *     plus a manual round-trip probe (one read-only cmd-135 query —
 *     no writes, no session mutation).
 *   - Input report monitor: passive `inputreport` listener decoding
 *     standard boot-keyboard reports (1 modifier byte + 6 keycodes).
 *     khub916 does not document per-key input on its vendor
 *     feature-report channel, so this shows whatever the keyboard
 *     sends as ordinary HID keyboard reports — raw hex for anything
 *     that is not an 8-byte boot report.
 *   - Key test / matrix viewer: physical layout from
 *     `k1pro-layout.ts` (same source as the Keys page), slot index +
 *     current-layer assignment per key, live press highlight.
 *   - Fn layer health: read-only doctor for "Fn+X does nothing"
 *     (bead `yw0`) — dead Fn-layer slots, opaque tag-0x08 values and
 *     the Fn key's own base-layer binding, via `fn-doctor.ts`.
 *   - Chatter & timing: capability-gated explanations only — the
 *     khub916 protocol exposes no per-key timing telemetry, so the
 *     page reports what the capability matrix says instead of faking
 *     measurements.
 *
 * STRICTLY READ-ONLY: the only device traffic this page can generate
 * is the optional latency probe (`session.power()`, a query command)
 * and passive `inputreport` listeners. No writes, no session mutation.
 */

import { app, connect } from './state.ts';
import { formatVidPid } from './hid.ts';
import {
  K1_PRO_BLOCKS,
  K1_PRO_LAYOUT_MODELS,
  keyIndexOf,
  layoutBounds,
  type KeyBlock,
} from './k1pro-layout.ts';
import { hidUsageLabel } from './proto/khub916.ts';
import {
  bootPressedUsages,
  ChatterTracker,
  decodeBootKeyboardReport,
  hexBytes,
  MODIFIER_LABELS,
  pressTokensForValue,
  ReportCadence,
  RolloverTracker,
  type RolloverSnapshot,
} from './diag-core.ts';
import { fnDoctorReport, renderFnDoctorInto } from './fn-doctor.ts';
import { getCapabilities, protocolOf } from './core/capabilities.ts';
import { describeFeature, isFeatureAvailable } from './core/feature-registry.ts';
import type { DeviceLike } from './core/device-model.ts';

// ── DOM helpers (same style as pages.ts/dashboard.ts) ──────────────────

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

function kv(dl: HTMLElement, key: string, value: string): void {
  const dt = el('dt', '', key);
  dt.dataset.k = key.toLowerCase().replace(/\s+/g, '-');
  dl.append(dt, el('dd', '', value));
}

// Boot keyboard report decoding + keymap-value → press-token mapping
// live in `./diag-core.ts` (DOM-free, smoke-tested).

// ── Live input-monitor state (module-level: survives page rebuilds) ────

interface InputStats {
  reports: number;
  bytes: number;
  firstAt: number;
  lastAt: number;
  /** Reports that were not 8-byte boot keyboard reports. */
  unrecognised: number;
  /** Hex of the most recent unrecognised report. */
  lastHex: string;
}

const freshStats = (): InputStats => ({
  reports: 0,
  bytes: 0,
  firstAt: 0,
  lastAt: 0,
  unrecognised: 0,
  lastHex: '',
});

let stats = freshStats();
/** Usages (keycodes + modifier usages) currently held down. */
const pressedUsages = new Set<number>();
let listenedDevice: HIDDevice | null = null;
let pageGrid: DiagGrid | null = null;
/** Element refs for live updates between state emits. */
let statRefs: {
  reports: HTMLElement;
  rate: HTMLElement;
  last: HTMLElement;
  unrecognised: HTMLElement;
  hex: HTMLElement;
  pressed: HTMLElement;
} | null = null;
let latencyResultEl: HTMLElement | null = null;
let lastLatency: { ms: number; ok: boolean; at: number } | null = null;

// ── Extended diagnostics state (bead 7l0) ─────────────────────────────
// Passive accumulators fed by the same input-report listener — they add
// no device traffic of their own.
const chatter = new ChatterTracker();
const cadence = new ReportCadence();
/** Chatter/cadence DOM refs, refreshed on each page render. */
let chatterBox: HTMLElement | null = null;
let cadenceDd: HTMLElement | null = null;
let lastChatterPaint = 0;
const CHATTER_PAINT_MS = 400;

// Active rollover test (window key listeners), if any. `box`/`actions`/
// `startBtn` are rebound on every page render because the card DOM is
// rebuilt while the test keeps running.
interface RolloverRun {
  tracker: RolloverTracker;
  box: HTMLElement;
  actions: HTMLElement;
  startBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  timer: ReturnType<typeof setInterval>;
  onDown: (e: KeyboardEvent) => void;
  onUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
}
let rolloverRun: RolloverRun | null = null;

function onInputReport(e: Event): void {
  const ev = e as unknown as { reportId: number; data: DataView };
  const bytes = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
  const now = Date.now();
  stats.reports += 1;
  stats.bytes += bytes.length;
  if (stats.firstAt === 0) stats.firstAt = now;
  stats.lastAt = now;
  cadence.push(now);

  pressedUsages.clear();
  const boot = decodeBootKeyboardReport(bytes);
  if (boot) {
    for (const u of boot.modUsages) pressedUsages.add(u);
    for (const u of boot.usages) pressedUsages.add(u);
    chatter.feed(bootPressedUsages(boot), now);
  } else {
    stats.unrecognised += 1;
    stats.lastHex = hexBytes(bytes);
  }
  paintLive();
}

function detachListener(): void {
  listenedDevice?.removeEventListener('inputreport', onInputReport);
  listenedDevice = null;
}

/** (Re)attach the passive input-report listener to the connected device. */
function ensureListener(device: HIDDevice | null): void {
  if (device === listenedDevice) return;
  detachListener();
  if (device) {
    device.addEventListener('inputreport', onInputReport);
    listenedDevice = device;
    stats = freshStats();
    pressedUsages.clear();
    lastLatency = null;
    chatter.reset();
    cadence.reset();
    lastChatterPaint = 0;
  }
}

/** Stop listening + drop element refs (navigation away / destroy). */
export function destroyDiagnostics(): void {
  detachListener();
  stopRollover();
  pageGrid?.destroy();
  pageGrid = null;
  statRefs = null;
  latencyResultEl = null;
  chatterBox = null;
  cadenceDd = null;
}

function usageLabel(u: number): string {
  return MODIFIER_LABELS[u] ?? hidUsageLabel(u) ?? `0x${u.toString(16).toUpperCase()}`;
}

/** Push live monitor state into the DOM without a full page rebuild. */
function paintLive(): void {
  if (statRefs) {
    statRefs.reports.textContent = String(stats.reports);
    statRefs.rate.textContent =
      stats.firstAt > 0 && stats.lastAt > stats.firstAt
        ? `${((stats.reports - 1) / ((stats.lastAt - stats.firstAt) / 1000)).toFixed(1)} reports/s`
        : '—';
    statRefs.last.textContent =
      stats.lastAt > 0 ? `${Math.max(0, Date.now() - stats.lastAt)} ms ago` : 'never';
    statRefs.unrecognised.textContent = String(stats.unrecognised);
    statRefs.hex.textContent = stats.lastHex || '—';

    // Pressed-key chips.
    statRefs.pressed.replaceChildren();
    if (pressedUsages.size === 0) {
      statRefs.pressed.append(el('span', 'diag-none', 'nothing held'));
    } else {
      for (const u of [...pressedUsages].sort((a, b) => a - b)) {
        statRefs.pressed.append(el('span', 'diag-chip diag-chip--down', usageLabel(u)));
      }
    }
  }
  pageGrid?.setPressed(pressedUsages);
  paintMeasured(Date.now());
}

/**
 * Push the measured cadence/chatter state into the timing card. Throttled
 * — input reports can arrive at kHz rates and this rebuilds a small list.
 */
function paintMeasured(now: number): void {
  const cs = cadence.stats();
  if (cadenceDd?.isConnected) {
    cadenceDd.textContent = cs
      ? `${cs.avgMs.toFixed(1)} ms avg gap (min ${cs.minMs.toFixed(1)}, max ${cs.maxMs.toFixed(1)}, n=${cs.samples})`
      : 'not enough reports yet';
  }
  if (!chatterBox?.isConnected) return;
  if (now - lastChatterPaint < CHATTER_PAINT_MS && chatterBox.childElementCount > 0) return;
  lastChatterPaint = now;
  paintChatter(chatterBox);
}

/** Render the per-usage timing table (top rows + chatter flags). */
function paintChatter(box: HTMLElement): void {
  box.replaceChildren();
  const rows = chatter.all().slice(0, 8);
  if (rows.length === 0) {
    box.append(el('p', 'hint', 'No decoded key transitions yet — press some keys.'));
    return;
  }
  const list = el('ul', 'diag-chatter');
  for (const t of rows) {
    const li = el('li', t.chatter ? 'diag-chatter-row diag-chatter-row--flag' : 'diag-chatter-row');
    const timing =
      t.lastPressMs !== null
        ? `last press ${t.lastPressMs.toFixed(0)} ms`
        : t.downAt !== null
          ? 'held'
          : '—';
    li.textContent =
      `${usageLabel(t.usage)} — ${t.presses} presses / ${t.releases} releases, ` +
      `${timing}${t.chatter ? ' · chatter?' : ''}`;
    list.append(li);
  }
  box.append(list);
  if (chatter.suspects().length === 0) {
    box.append(
      el(
        'p',
        'hint',
        'No chatter suspects. Durations are quantised by the report cadence — ' +
          'treat "chatter?" rows as hints to verify by hand, not proof.',
      ),
    );
  } else {
    box.append(
      el(
        'p',
        'hint warn',
        `${chatter.suspects().length} key(s) show press/release flicker faster ` +
          'than 30 ms — possible switch chatter or a marginal actuation point.',
      ),
    );
  }
}

// ── Matrix / key-test grid ─────────────────────────────────────────────

interface GridCell {
  el: HTMLElement;
  /** Boot-report usages that mark this key as pressed (all must match). */
  tokens: readonly number[];
}

class DiagGrid {
  readonly viewport: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly bounds: { width: number; height: number };
  private readonly cells: GridCell[] = [];
  private readonly detail: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    root: HTMLElement,
    blocks: readonly KeyBlock[],
    labels: ReadonlyMap<number, string>,
    tokensFor: (index: number) => readonly number[],
    onSelect: (index: number, name: string, assigned: string) => void,
  ) {
    this.bounds = layoutBounds(blocks);
    this.viewport = el('div', 'kb-viewport diag-viewport');
    this.canvas = el('div', 'kb-canvas');
    this.detail = el('div', 'kb-detail');
    this.viewport.append(this.canvas);
    root.append(this.viewport, this.detail);

    this.canvas.style.width = `${this.bounds.width}px`;
    this.canvas.style.height = `${this.bounds.height}px`;

    for (const block of blocks) {
      if (!block.display) continue;
      const n = keyIndexOf(block.pos);
      const cell = el('div', 'kb-key kb-key--idle diag-key');
      cell.style.left = `${block.x}px`;
      cell.style.top = `${block.y}px`;
      cell.style.width = `${block.width}px`;
      cell.style.height = `${block.height}px`;

      const idx = el('span', 'diag-key-idx', String(n));
      const label = el('span', 'kb-key-label', labels.get(n) ?? block.name.replace(/_/g, ' '));
      cell.append(idx, label);
      const name = block.name || '(unnamed)';
      const assigned = labels.get(n) ?? '';
      cell.title = `Slot ${n} — ${name}${assigned ? ` → ${assigned}` : ''}`;
      cell.addEventListener('click', () => onSelect(n, name, assigned));
      this.canvas.append(cell);
      this.cells.push({ el: cell, tokens: tokensFor(n) });
    }
    this.fit();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.viewport);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.viewport.remove();
    this.detail.remove();
  }

  /** Highlight every key whose token set is fully pressed. */
  setPressed(usages: ReadonlySet<number>): void {
    for (const c of this.cells) {
      const down = c.tokens.length > 0 && c.tokens.every((t) => usages.has(t));
      c.el.classList.toggle('diag-key--down', down);
    }
  }

  showDetail(text: string): void {
    this.detail.textContent = text;
  }

  /** Scale the px canvas to fit the viewport width (same as KeyboardView). */
  private fit(): void {
    const avail = this.viewport.clientWidth;
    const scale = avail > 0 ? Math.min(1, avail / this.bounds.width) : 1;
    this.canvas.style.transform = `scale(${scale})`;
    this.viewport.style.height = `${this.bounds.height * scale}px`;
  }
}

// ── Key rollover test (OS-level, window key events) ────────────────────
//
// This measures what the OS delivered to the page — NOT the device's
// matrix wiring. NKRO vs 6KRO only becomes visible here if the OS HID
// stack itself delivers more simultaneous keys; a boot-protocol-only
// device caps at 6 keys + 8 modifiers regardless of matrix quality.

function rolloverLine(s: RolloverSnapshot): string {
  return (
    `${s.heldCount} held · peak ${s.peak} · ${s.presses} presses / ` +
    `${s.releases} releases · ${s.repeats} repeats ignored` +
    (s.lostReleases > 0 ? ` · ${s.lostReleases} lost on blur` : '') +
    (s.orphanReleases > 0 ? ` · ${s.orphanReleases} unmatched keyups` : '')
  );
}

function paintRollover(box: HTMLElement, s: RolloverSnapshot): void {
  box.replaceChildren();
  const chips = el('div', 'diag-pressed');
  if (s.heldCount === 0) {
    chips.append(el('span', 'diag-none', 'no keys held'));
  } else {
    for (const code of s.held.slice(0, 32)) {
      chips.append(el('span', 'diag-chip diag-chip--down', code));
    }
    if (s.heldCount > 32) {
      chips.append(el('span', 'diag-none', `+${s.heldCount - 32} more`));
    }
  }
  box.append(chips, el('p', 'diag-hex', rolloverLine(s)));
}

function stopRollover(): void {
  const run = rolloverRun;
  if (!run) return;
  rolloverRun = null;
  window.removeEventListener('keydown', run.onDown, true);
  window.removeEventListener('keyup', run.onUp, true);
  window.removeEventListener('blur', run.onBlur);
  clearInterval(run.timer);
  run.stopBtn.remove();
  if (run.startBtn.isConnected) {
    run.startBtn.disabled = false;
    run.startBtn.textContent = 'Start rollover test';
  }
}

function startRollover(
  box: HTMLElement,
  actions: HTMLElement,
  startBtn: HTMLButtonElement,
): void {
  stopRollover();
  const tracker = new RolloverTracker();
  const onDown = (e: KeyboardEvent): void => tracker.down(e.code);
  const onUp = (e: KeyboardEvent): void => tracker.up(e.code);
  const onBlur = (): void => tracker.reset();
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);
  const stopBtn = el('button', '', 'Stop test') as HTMLButtonElement;
  stopBtn.type = 'button';
  const run: RolloverRun = {
    tracker,
    box,
    actions,
    startBtn,
    stopBtn,
    timer: setInterval(() => {
      if (rolloverRun === run) paintRollover(run.box, run.tracker.snapshot());
    }, 200),
    onDown,
    onUp,
    onBlur,
  };
  rolloverRun = run;
  stopBtn.addEventListener('click', () => {
    const target = run.box.isConnected ? run.box : box;
    stopRollover();
    paintRollover(target, tracker.snapshot());
    target.append(
      el(
        'p',
        'hint',
        'Test stopped. Press "Start rollover test" to run it again — ' +
          'hold several keys at once and watch the held count.',
      ),
    );
  });
  actions.append(stopBtn);
  startBtn.disabled = true;
  startBtn.textContent = 'Testing…';
  paintRollover(box, tracker.snapshot());
}

// ── Page ───────────────────────────────────────────────────────────────

export function renderDiagnostics(root: HTMLElement): void {
  root.replaceChildren();
  pageGrid?.destroy();
  pageGrid = null;
  statRefs = null;
  latencyResultEl = null;
  chatterBox = null;
  cadenceDd = null;

  if (!app.connected || !app.snapshot) {
    // Disconnected: drop the passive listener, reset live stats, and
    // stop any rollover test (its UI is gone with the page body).
    ensureListener(null);
    stopRollover();
    const { card: c, body } = card('Diagnostics');
    body.append(
      el('p', 'coming-soon', 'No keyboard connected.'),
      el(
        'p',
        'hint',
        'Diagnostics is read-only: it watches the link, shows which keys ' +
          'the keyboard reports, and explains which tests this protocol ' +
          'can actually perform. Connect a keyboard to begin.',
      ),
    );
    const connectBtn = el('button', 'primary', 'Connect keyboard');
    connectBtn.type = 'button';
    connectBtn.disabled = app.busy;
    connectBtn.addEventListener('click', () => void connect());
    body.append(connectBtn);
    root.append(c);
    return;
  }

  const dev = app.connected.device;
  const snap = app.snapshot;
  const like: DeviceLike = {
    vendorId: dev.vendorId,
    productId: dev.productId,
    productName: dev.productName ?? null,
    uuid: snap.info.uuid,
    catalogModel: snap.info.catalogModel,
    catalogName: snap.info.catalogName,
    screenSize: snap.info.screenSize,
  };
  const caps = getCapabilities(like);
  const protocol = protocolOf(like);
  const session = app.connected.session;

  ensureListener(dev);

  // ── 1. Connection quality ──────────────────────────────────────────
  const connCard = card('Connection quality');
  const cdl = el('dl', 'kv');
  kv(cdl, 'Transport', 'USB feature reports (khub916 wired)');
  kv(cdl, 'Report channel', `id ${app.connected.reportId} · ${formatVidPid(dev)}`);
  kv(
    cdl,
    'Session state',
    session.isPoisoned
      ? `interrupted — ${session.poisonMessage || 'transfer error'}`
      : session.writesBlocked
        ? 'connected (writes paused after silent reconnect)'
        : 'healthy',
  );
  kv(
    cdl,
    'Link state',
    app.reconnectedSilently ? 'reconnected silently — changes blocked' : 'connected',
  );
  connCard.body.append(cdl);

  // Manual round-trip probe: one read-only cmd-135 power query.
  const probeBtn = el('button', '', 'Measure link latency');
  probeBtn.type = 'button';
  probeBtn.addEventListener('click', () => {
    void (async () => {
      if (!app.connected) return;
      probeBtn.disabled = true;
      probeBtn.textContent = 'Measuring…';
      const t0 = performance.now();
      try {
        await app.connected.session.power();
        lastLatency = { ms: performance.now() - t0, ok: true, at: Date.now() };
      } catch {
        lastLatency = { ms: performance.now() - t0, ok: false, at: Date.now() };
      }
      probeBtn.disabled = false;
      probeBtn.textContent = 'Measure again';
      if (latencyResultEl?.isConnected) {
        latencyResultEl.textContent = latencyText(lastLatency);
      }
    })();
  });
  latencyResultEl = el(
    'dd',
    'diag-latency',
    lastLatency ? latencyText(lastLatency) : 'not measured yet',
  );
  const latDl = el('dl', 'kv diag-kv');
  const latDt = el('dt', '', 'Round-trip');
  latDt.dataset.k = 'latency';
  latDl.append(latDt, latencyResultEl);
  connCard.body.append(probeBtn, latDl);

  // ── 2. Input report monitor ────────────────────────────────────────
  const liveCard = card('Input report monitor');
  liveCard.body.append(
    el(
      'p',
      'hint',
      'Passive listener on the keyboard\'s standard HID input reports. ' +
        'The khub916 vendor protocol does not document per-key input on ' +
        'its feature-report channel, so this shows whatever the keyboard ' +
        'sends as ordinary HID keyboard reports — press keys to test.',
    ),
  );
  const reportsDd = el('dd', '', '0');
  const rateDd = el('dd', '', '—');
  const lastDd = el('dd', '', 'never');
  const unrecDd = el('dd', '', '0');
  const hexDd = el('dd', 'diag-hex', '—');
  const liveDl = el('dl', 'kv diag-kv');
  const mkDt = (k: string, label: string): HTMLElement => {
    const dt = el('dt', '', label);
    dt.dataset.k = k;
    return dt;
  };
  liveDl.append(
    mkDt('reports', 'Reports seen'), reportsDd,
    mkDt('rate', 'Report rate'), rateDd,
    mkDt('last', 'Last report'), lastDd,
    mkDt('unrecognised', 'Unrecognised'), unrecDd,
    mkDt('raw', 'Last raw report'), hexDd,
  );
  liveCard.body.append(liveDl);
  const pressedBox = el('div', 'diag-pressed');
  statRefs = {
    reports: reportsDd,
    rate: rateDd,
    last: lastDd,
    unrecognised: unrecDd,
    hex: hexDd,
    pressed: pressedBox,
  };
  liveCard.body.append(el('p', 'diag-pressed-label', 'Currently held:'));
  liveCard.body.append(pressedBox);
  liveCard.body.append(
    el(
      'p',
      'hint',
      'Only 8-byte boot-protocol reports are decoded into key names; ' +
        'anything else (NKRO, vendor frames) is counted and shown as hex. ' +
        'If nothing arrives, the keyboard may not expose input reports ' +
        'to WebHID on this firmware — that is a device limitation, not a bug.',
    ),
  );

  // ── 3. Key test / matrix viewer ────────────────────────────────────
  const matrixCard = card('Key test — physical matrix');
  if (!isFeatureAvailable(caps, 'keymap-editor')) {
    matrixCard.body.append(
      el('p', 'coming-soon', 'Not available on this device.'),
      el('p', 'hint', describeFeature(caps, 'keymap-editor')),
    );
  } else {
    const model = snap.info.catalogModel;
    // Only the K1 Pro layout table is ported; other models fall back to
    // it with a warning (same rule as remap.ts `blocksForModel`).
    const layoutNote =
      model && !K1_PRO_LAYOUT_MODELS.includes(model)
        ? `Layout table for ${model} is not ported yet — showing the K1 Pro reference layout.`
        : !model
          ? 'Model unknown — showing the K1 Pro reference layout.'
          : null;
    if (layoutNote) matrixCard.body.append(el('p', 'hint warn', layoutNote));

    // Labels: current layer's decoded keymap, factory name as fallback.
    const blocks = K1_PRO_BLOCKS;
    const labels = new Map<number, string>();
    const layerEntries = snap.keymaps.get(app.layer);
    const factoryValue = new Map<number, number>();
    for (const b of blocks) {
      if (!b.display) continue;
      const n = keyIndexOf(b.pos);
      const entry = layerEntries?.[n];
      labels.set(n, entry?.label || b.name.replace(/_/g, ' '));
      factoryValue.set(n, parseInt(b.value, 16));
    }
    // Press tokens from the *effective* value (live keymap wins over the
    // factory default so remapped keys highlight correctly).
    const tokensFor = (index: number): readonly number[] => {
      const v = layerEntries?.[index]?.value ?? factoryValue.get(index) ?? 0;
      return pressTokensForValue(v);
    };
    const holder = el('div', 'diag-grid-holder');
    matrixCard.body.append(holder);
    matrixCard.body.append(
      el(
        'p',
        'hint',
        `Showing key set ${app.layer + 1}. Keys light up when the keyboard ` +
          'reports the matching HID usage — a press that never lights a ' +
          'key means the firmware is not reporting it over standard HID.',
      ),
    );
    pageGrid = new DiagGrid(
      holder,
      blocks,
      labels,
      tokensFor,
      (index, name, assigned) => {
        pageGrid?.showDetail(
          `Slot ${index} (${name}) → ${assigned || 'unassigned'}` +
            (assigned ? '' : ' — no keymap entry on this layer'),
        );
      },
    );
  }

  // ── 4. Key rollover test (OS-level, window key events) ─────────────
  // Counts simultaneous keys the OS delivers to this page. Honest
  // boundary: this is NOT a matrix-wiring test — NKRO vs 6KRO only shows
  // here if the OS HID stack delivers >6 keys; a boot-protocol-only
  // device caps at 6 keys + 8 modifiers regardless of matrix quality.
  const rollCard = card('Key rollover test');
  if (!isFeatureAvailable(caps, 'keymap-editor')) {
    // Capability lost mid-test (should not happen, but never leak
    // window listeners on a card that cannot show the test).
    stopRollover();
    rollCard.body.append(
      el('p', 'coming-soon', 'Not available on this device.'),
      el('p', 'hint', describeFeature(caps, 'keymap-editor')),
    );
  } else {
    rollCard.body.append(
      el(
        'p',
        'hint',
        'Press "Start rollover test", then hold several keys at once. ' +
          'The count tracks OS-level key events (KeyboardEvent.code), so ' +
          'auto-repeat is ignored and layout does not matter. A peak above ' +
          '6 means the OS is delivering NKRO-style reports; stuck at 6+8 ' +
          'modifiers suggests boot-protocol rollover. This measures what ' +
          'the OS gave the page — not the switch matrix itself.',
      ),
    );
    const rollBox = el('div', 'diag-rollover');
    const rollActions = el('div', 'diag-rollover-actions');
    const rollStart = el('button', '', 'Start rollover test') as HTMLButtonElement;
    rollStart.type = 'button';
    rollStart.addEventListener('click', () =>
      startRollover(rollBox, rollActions, rollStart),
    );
    rollActions.append(rollStart);
    rollCard.body.append(rollBox, rollActions);
    // A test started before this re-render keeps running — rebind its
    // live UI to the fresh DOM.
    const active = rolloverRun;
    if (active) {
      active.box = rollBox;
      active.actions = rollActions;
      active.startBtn = rollStart;
      rollActions.append(active.stopBtn);
      rollStart.disabled = true;
      rollStart.textContent = 'Testing…';
      paintRollover(rollBox, active.tracker.snapshot());
    }
  }

  // ── 5. Fn layer health (read-only doctor) ──────────────────────────
  // "Fn+X does nothing" diagnosable without guessing (bead yw0): reads
  // keymap args 0x01/0x00 through the session cache and reports dead
  // slots, opaque tags and the Fn key's own binding. No writes.
  const fnCard = card('Fn layer health');
  if (protocol !== 'khub916' || !isFeatureAvailable(caps, 'keymap-editor')) {
    fnCard.body.append(
      el('p', 'coming-soon', 'Not available on this device.'),
      el('p', 'hint', describeFeature(caps, 'keymap-editor')),
    );
  } else {
    const fnBox = el('div', 'fn-doc');
    fnBox.append(el('p', 'hint', 'Checking the Fn layer (read-only)…'));
    fnCard.body.append(fnBox);
    void fnDoctorReport()
      .then((report) => {
        if (!fnBox.isConnected) return;
        if (report) {
          renderFnDoctorInto(fnBox, report);
        } else {
          fnBox.replaceChildren(
            el('p', 'hint', 'Could not read the Fn-layer keymap — the check needs a successful keymap read.'),
          );
        }
      })
      .catch((e) => {
        if (!fnBox.isConnected) return;
        fnBox.replaceChildren(
          el(
            'p',
            'hint warn',
            `Fn-layer check failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      });
  }

  // ── 6. Chatter & timing (measured where possible, honest elsewhere) ──
  const timingCard = card('Chatter & timing');

  // Measured: input-report delivery cadence + per-usage press timing,
  // both derived passively from the boot-report stream above. No extra
  // device traffic.
  const measDl = el('dl', 'kv diag-kv');
  const cadDt = el('dt', '', 'Input report cadence');
  cadDt.dataset.k = 'report-cadence';
  cadenceDd = el('dd', '', '—');
  measDl.append(cadDt, cadenceDd);
  timingCard.body.append(measDl);
  chatterBox = el('div', 'diag-chatter-box');
  timingCard.body.append(chatterBox);
  timingCard.body.append(
    el(
      'p',
      'hint',
      'Cadence is the gap between consecutive input reports as the browser ' +
        'received them — a delivery measurement, not the keyboard scan rate. ' +
        'Chatter flags are heuristic: a usage with ≥4 presses and a sub-30 ms ' +
        'press, quantised by the report cadence.',
    ),
  );

  // Capability context: what the protocol claims vs what was measured.
  const timingDl = el('dl', 'kv diag-kv');
  for (const feature of ['live-travel', 'polling', 'actuation'] as const) {
    const dt = el('dt', '', feature.replace(/-/g, ' '));
    dt.dataset.k = feature;
    timingDl.append(dt, el('dd', '', describeFeature(caps, feature)));
  }
  timingCard.body.append(timingDl);
  timingCard.body.append(
    el(
      'p',
      'hint',
      protocol === 'khub916'
        ? 'The khub916 wired protocol exposes no per-key chatter, debounce ' +
          'or latency telemetry — the cadence and press timings above are ' +
          'the only real measurements, taken from standard HID reports. ' +
          'Protocol-level claims come from the capability matrix.'
        : 'This protocol has no wired diagnostics transport in the web app ' +
          'yet — timing data above comes from the capability matrix.',
    ),
  );

  // ── 7. Matrix scan & analog travel (honest availability) ────────────
  const scanCard = card('Matrix scan & analog travel');
  if (protocol === 'he-v2') {
    scanCard.body.append(
      el(
        'p',
        'hint',
        isFeatureAvailable(caps, 'live-travel')
          ? 'Per-row live travel (`04 03`) runs on the Performance Studio ' +
            'page — code-verified, hardware-unverified. It is a UI poll ' +
            'loop over matrix rows, not a device-side full-matrix scan ' +
            'dump, so per-key scan timing cannot be measured from here.'
          : describeFeature(caps, 'live-travel'),
      ),
    );
  } else if (protocol === 'sparkplayjoy') {
    scanCard.body.append(
      el(
        'p',
        'hint',
        'The SparkPlayJoy 6×21 analog travel stream exists only in the ' +
          'Rust CLI (`omg kb travel-matrix`); the web app has no transport ' +
          'for this protocol yet, so no matrix scan is possible here.',
      ),
    );
  } else if (protocol === 'khub916') {
    scanCard.body.append(
      el(
        'p',
        'hint',
        'Mechanical-switch keyboard — the khub916 protocol exposes no ' +
          'analog travel or matrix-scan telemetry. Boot-protocol input ' +
          'reports (6-key rollover) are the only key-state channel.',
      ),
    );
  } else {
    scanCard.body.append(
      el('p', 'hint', describeFeature(caps, 'live-travel')),
    );
  }

  root.append(
    connCard.card,
    liveCard.card,
    matrixCard.card,
    rollCard.card,
    fnCard.card,
    timingCard.card,
    scanCard.card,
  );
  paintLive();
}

function latencyText(l: { ms: number; ok: boolean; at: number }): string {
  const when = new Date(l.at).toLocaleTimeString();
  return l.ok
    ? `${l.ms.toFixed(1)} ms round trip (${when})`
    : `query failed after ${l.ms.toFixed(0)} ms (${when})`;
}
