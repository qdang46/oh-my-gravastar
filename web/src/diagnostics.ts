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
  decodeBootKeyboardReport,
  hexBytes,
  MODIFIER_LABELS,
  pressTokensForValue,
} from './diag-core.ts';
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

function onInputReport(e: Event): void {
  const ev = e as unknown as { reportId: number; data: DataView };
  const bytes = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
  const now = Date.now();
  stats.reports += 1;
  stats.bytes += bytes.length;
  if (stats.firstAt === 0) stats.firstAt = now;
  stats.lastAt = now;

  pressedUsages.clear();
  const boot = decodeBootKeyboardReport(bytes);
  if (boot) {
    for (const u of boot.modUsages) pressedUsages.add(u);
    for (const u of boot.usages) pressedUsages.add(u);
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
  }
}

/** Stop listening + drop element refs (navigation away / destroy). */
export function destroyDiagnostics(): void {
  detachListener();
  pageGrid?.destroy();
  pageGrid = null;
  statRefs = null;
  latencyResultEl = null;
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

// ── Page ───────────────────────────────────────────────────────────────

export function renderDiagnostics(root: HTMLElement): void {
  root.replaceChildren();
  pageGrid?.destroy();
  pageGrid = null;
  statRefs = null;
  latencyResultEl = null;

  if (!app.connected || !app.snapshot) {
    // Disconnected: drop the passive listener and reset live stats.
    ensureListener(null);
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

  // ── 4. Chatter & timing (capability-gated, honest) ─────────────────
  const timingCard = card('Chatter & timing');
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
          'or latency telemetry — only the transport stats above are real ' +
          'measurements. Everything else is reported from the capability ' +
          'matrix, not measured.'
        : 'This protocol has no wired diagnostics transport in the web app ' +
          'yet — timing data above comes from the capability matrix.',
    ),
  );

  root.append(connCard.card, liveCard.card, matrixCard.card, timingCard.card);
  paintLive();
}

function latencyText(l: { ms: number; ok: boolean; at: number }): string {
  const when = new Date(l.at).toLocaleTimeString();
  return l.ok
    ? `${l.ms.toFixed(1)} ms round trip (${when})`
    : `query failed after ${l.ms.toFixed(0)} ms (${when})`;
}
