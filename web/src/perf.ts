/**
 * Performance Studio — HE (Hall-effect) keyboard page (bead `xp0`).
 *
 * Per-key actuation point, rapid trigger, deadzones and DKS/MPT
 * advanced-key editors plus a live travel monitor and calibration
 * entry points, all driven through `HeSession` (`./he.ts`) — the same
 * verified write paths as `omg kb perf|hk|live|calibration`.
 *
 * CAPABILITY-GATED (hard requirement): every section asks the core
 * capability registry (`core/capabilities.ts` + `feature-registry.ts`)
 * what the *connected* device supports. On a khub916 mechanical
 * keyboard (K1 Pro etc.) every HE feature reports
 * `unsupported-hardware` and the page renders honest "not available"
 * copy instead of controls — it never fakes support.
 *
 * SAFETY: every write goes through `confirmDialog` first (the web
 * equivalent of `--yes`), range validation happens in `perf-core.ts`
 * before anything is sent, and each mutation is read-back verified by
 * `HeSession` — the outcome (`verified` true/false) is reported
 * verbatim. Calibration (`02 06`) and polling-rate writes are L3
 * device operations: calibration gets an explicit confirmation
 * explaining the on-device behaviour, and polling is intentionally
 * NOT exposed here (the keyboard restarts and drops off the bus).
 *
 * HONESTY: all HE v2 write paths are code-verified, hardware-unverified
 * (docs/CAPABILITY-MATRIX.md — no HE keyboard has been exercised).
 * That caveat is shown in the page copy, not hidden.
 */

import { app, setStatus, subscribe } from './state.ts';
import {
  openHe,
  reopenHe,
  requestHeDevice,
  type ConnectedHe,
} from './he.ts';
import {
  HE_USAGE_PAGE,
  HK_MODE,
  type HigherKeyConfig,
  type HigherKeyParams,
  type KeyboardInfo,
  type KeyPerf,
  type KeySlot,
  type LiveKey,
} from './proto/he.ts';
import { getCapabilities, protocolOf, type CapabilityMap } from './core/capabilities.ts';
import { describeFeature, isFeatureAvailable, type FeatureId } from './core/feature-registry.ts';
import type { DeviceLike } from './core/device-model.ts';
import { confirmDialog } from './modal.ts';
import {
  HK_EDITABLE_MODES,
  applyPerfDraft,
  buildHkParams,
  heKeyLabel,
  hkConfigSummary,
  hkDraftError,
  layoutKeyGrid,
  liveRowSummary,
  maxTravelFor,
  parseKcInput,
  parseMmInput,
  perfChanges,
  travelFill,
  validatePerfDraft,
  type HkEditableMode,
  type PerfDraft,
} from './perf-core.ts';

// ── DOM helpers (same style as diagnostics.ts/pages.ts) ────────────────

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

function field(label: string, input: HTMLElement): HTMLElement {
  const wrap = el('label', 'macro-field');
  wrap.append(el('span', 'macro-field-label', label), input);
  return wrap;
}

function numInput(value: string, title = ''): HTMLInputElement {
  const i = el('input', 'macro-num') as HTMLInputElement;
  i.type = 'number';
  i.step = '0.05';
  i.value = value;
  if (title) i.title = title;
  return i;
}

function textInput(value: string, title = ''): HTMLInputElement {
  const i = el('input', 'macro-num') as HTMLInputElement;
  i.type = 'text';
  i.value = value;
  if (title) i.title = title;
  return i;
}

// ── Module state ───────────────────────────────────────────────────────
//
// The HE session is owned by this module, NOT by `state.ts` (which only
// knows khub916). It survives page navigation so leaving and returning
// does not drop the HID handle; `destroyPerfPage` stops the live-travel
// poll but keeps the session.

let he: ConnectedHe | null = null;
let heInfo: KeyboardInfo | null = null;
let heCaps: CapabilityMap | null = null;
/** `03 05` geometry for every matrix row. */
let slots: KeySlot[] = [];
/** Layer-0 keycodes per matrix row (`03 01`), keyed by row. */
let keycodes = new Map<number, number[]>();
/** Per-key `04 01` perf cache, keyed `row:col`. */
let perfs = new Map<string, KeyPerf>();
/** Per-key cat-6 bank reads, keyed `row:col` → mode-name → config. */
let hkBanks = new Map<string, Map<string, HigherKeyConfig>>();
let selected: { row: number; col: number } | null = null;
let detailLoading = false;
let busy = false;
let heError = '';

interface LiveState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** Latest `04 03` readings per matrix row. */
  rows: Map<number, LiveKey[]>;
  error: string;
  ticking: boolean;
}
const live: LiveState = { active: false, timer: null, rows: new Map(), error: '', ticking: false };

const perfKey = (row: number, col: number): string => `${row}:${col}`;

// ── HE session lifecycle ───────────────────────────────────────────────

async function connectHe(): Promise<void> {
  if (busy) return;
  busy = true;
  setStatus('Pick your HE keyboard in the browser window…');
  try {
    const device = await requestHeDevice();
    if (!device) {
      setStatus('Keyboard picker closed — press Connect HE keyboard to try again.');
      return;
    }
    setStatus('Connecting HE keyboard…');
    he = await openHe(device);
    heError = '';
    heCaps = getCapabilities({
      vendorId: device.vendorId,
      productId: device.productId,
      usagePage: HE_USAGE_PAGE,
    });
    // Sequential reads — the protocol is one-request-at-a-time.
    heInfo = await he.session.info();
    slots = await he.session.keySlots();
    keycodes = new Map();
    perfs = new Map();
    hkBanks = new Map();
    selected = null;
    live.rows = new Map();
    stopLive();
    setStatus(
      `Connected — ${device.productName ?? 'GravaStar HE keyboard'} ` +
        `(protocol ${heInfo.protocol}, firmware ${heInfo.firmware}).`,
    );
  } catch (e) {
    he = null;
    heInfo = null;
    heCaps = null;
    slots = [];
    heError = e instanceof Error ? e.message : String(e);
    setStatus(`Could not connect the HE keyboard: ${heError}`, true);
  } finally {
    busy = false;
    studio?.render();
  }
}

async function reconnectHe(): Promise<void> {
  if (!he || busy) return;
  busy = true;
  try {
    he = await reopenHe(he.device);
    heInfo = await he.session.info();
    slots = await he.session.keySlots();
    perfs = new Map();
    hkBanks = new Map();
    setStatus('HE keyboard reconnected.');
  } catch (e) {
    setStatus(`Could not reconnect: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    busy = false;
    studio?.render();
  }
}

function disconnectHe(): void {
  stopLive();
  const c = he;
  he = null;
  heInfo = null;
  heCaps = null;
  slots = [];
  keycodes = new Map();
  perfs = new Map();
  hkBanks = new Map();
  selected = null;
  void c?.device.close().catch(() => {});
  setStatus('HE keyboard disconnected.');
  studio?.render();
}

// ── Key data loading ───────────────────────────────────────────────────

/** Rows that actually have physical keys (geometry said so). */
function activeRows(): number[] {
  return [...new Set(slots.map((s) => s.row))].sort((a, b) => a - b);
}

async function loadKeycodes(): Promise<void> {
  if (!he) return;
  keycodes = new Map();
  // Layer 0 is the base layer; labels are cosmetic only.
  for (const row of activeRows()) {
    try {
      keycodes.set(row, await he.session.keyCodes(0, row));
    } catch {
      keycodes.set(row, []);
    }
  }
}

async function loadPerf(row: number, col: number): Promise<void> {
  if (!he) return;
  const k = perfKey(row, col);
  if (perfs.has(k)) return;
  try {
    perfs.set(k, await he.session.keyPerf(row, col));
  } catch (e) {
    setStatus(
      `Could not read actuation settings for r${row}c${col}: ${e instanceof Error ? e.message : String(e)}`,
      true,
    );
  }
}

/**
 * Read every cat-6 mode bank for one key — the vendor driver does the
 * same enumeration on connect (`getHigherKeyData` per mode). Reads are
 * cheap and safe; failures are recorded per-bank, never fatal.
 */
async function loadHkBanks(row: number, col: number): Promise<void> {
  if (!he) return;
  const k = perfKey(row, col);
  const banks = new Map<string, HigherKeyConfig>();
  hkBanks.set(k, banks);
  for (const mode of Object.keys(HK_MODE) as (keyof typeof HK_MODE)[]) {
    try {
      banks.set(mode, await he.session.higherKey(row, col, HK_MODE[mode]));
    } catch {
      // A bank that does not answer is simply absent from the map.
    }
  }
}

async function selectKey(row: number, col: number): Promise<void> {
  selected = { row, col };
  detailLoading = true;
  studio?.renderDetail();
  await Promise.all([loadPerf(row, col), loadHkBanks(row, col)]);
  detailLoading = false;
  studio?.renderDetail();
}

// ── Live travel monitor ────────────────────────────────────────────────

const LIVE_POLL_MS = 250;

async function liveTick(): Promise<void> {
  if (!he || !live.active || live.ticking) return;
  live.ticking = true;
  live.error = '';
  try {
    for (const row of activeRows()) {
      if (!live.active) break;
      try {
        live.rows.set(row, await he.session.liveRow(row));
      } catch (e) {
        live.error = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    live.ticking = false;
    studio?.paintLive();
  }
}

function startLive(): void {
  if (!he || live.active) return;
  live.active = true;
  live.error = '';
  void liveTick();
  live.timer = setInterval(() => void liveTick(), LIVE_POLL_MS);
  studio?.renderLiveCard();
}

function stopLive(): void {
  live.active = false;
  if (live.timer !== null) {
    clearInterval(live.timer);
    live.timer = null;
  }
  // Drop stale readings so the grid bars don't freeze at old values.
  live.rows.clear();
  studio?.paintLive();
}

// ── Writes (all confirmed + verified through HeSession) ────────────────

const HE_UNVERIFIED_NOTE =
  'HE v2 writes in this app are code-verified but have not been tested on real hardware yet.';

async function savePerf(row: number, col: number, draft: PerfDraft): Promise<void> {
  if (!he || busy) return;
  const base = perfs.get(perfKey(row, col));
  if (!base) return;
  const next = applyPerfDraft(base, draft);
  const changes = perfChanges(base, next);
  const ok = await confirmDialog({
    title: `Save actuation settings for key r${row}c${col}?`,
    bodyText:
      'The change is written to the keyboard immediately — there is no undo. ' +
      'The app reads the settings back afterwards and reports whether the keyboard confirmed them.',
    details: changes,
    hint: HE_UNVERIFIED_NOTE,
    impact: {
      affected: [`Actuation settings for key r${row}c${col}`],
      persistent: true,
      // HE sessions have no SnapshotStore/profile-history backup path.
      backupCaptured: false,
      rollback: 'none',
      restartRisk: false,
    },
    confirmLabel: 'Save to keyboard',
  });
  if (!ok) return;
  const session = he?.session;
  if (!session) return; // disconnected while the confirm was open
  busy = true;
  studio?.renderDetail();
  try {
    const outcome = await session.setKeyPerf(row, col, next);
    // Trust the read-back the session just performed.
    perfs.set(perfKey(row, col), await session.keyPerf(row, col));
    setStatus(
      `Actuation settings for r${row}c${col} saved — ` +
        (outcome.verified ? 'verified on the keyboard.' : 'sent, but the keyboard did not confirm the read-back.'),
    );
  } catch (e) {
    setStatus(`Could not save actuation settings: ${e instanceof Error ? e.message : String(e)}`, true);
    perfs.delete(perfKey(row, col));
    void loadPerf(row, col);
  } finally {
    busy = false;
    studio?.renderDetail();
  }
}

async function saveHk(
  row: number,
  col: number,
  mode: HkEditableMode,
  kcs: number[],
  nums: number[],
): Promise<void> {
  if (!he || busy) return;
  const err = hkDraftError(mode, kcs, nums);
  if (err) {
    setStatus(`Advanced-key settings not valid: ${err}`, true);
    return;
  }
  const params: HigherKeyParams =
    mode === 'none' ? { mode: 'none' } : buildHkParams(mode as 'dks' | 'mpt', kcs, nums);
  const summary =
    mode === 'none'
      ? 'remove the advanced-key function (the key returns to normal)'
      : `${mode.toUpperCase()} with ${kcs.length} keycode(s)`;
  const ok = await confirmDialog({
    title: `Save advanced-key settings for key r${row}c${col}?`,
    bodyText:
      `This writes the ${summary} configuration to the keyboard immediately — there is no undo. ` +
      'Advanced-key writes are confirmed by the device echo; the app reports what came back.',
    hint: HE_UNVERIFIED_NOTE,
    impact: {
      affected: [`Advanced-key settings for key r${row}c${col}`],
      persistent: true,
      backupCaptured: false,
      rollback: 'none',
      restartRisk: false,
    },
    confirmLabel: 'Save to keyboard',
  });
  if (!ok) return;
  const session = he?.session;
  if (!session) return;
  busy = true;
  studio?.renderDetail();
  try {
    const echoes = await session.setHigherKey(row, col, params);
    const back = await session.higherKey(row, col, params.mode === 'none' ? 'none' : params.mode);
    const banks = hkBanks.get(perfKey(row, col)) ?? new Map<string, HigherKeyConfig>();
    banks.set(params.mode, back);
    hkBanks.set(perfKey(row, col), banks);
    setStatus(
      `Advanced-key settings for r${row}c${col} saved — device echoed mode ${echoes.length} packet(s).`,
    );
  } catch (e) {
    setStatus(`Could not save advanced-key settings: ${e instanceof Error ? e.message : String(e)}`, true);
    hkBanks.delete(perfKey(row, col));
    void loadHkBanks(row, col);
  } finally {
    busy = false;
    studio?.renderDetail();
  }
}

async function runCalibration(start: boolean): Promise<void> {
  if (!he || busy) return;
  const ok = await confirmDialog({
    title: start ? 'Start travel calibration?' : 'Finish travel calibration?',
    bodyText: start
      ? 'This puts the keyboard into calibration mode: every key must then be pressed fully and released so the firmware can learn the switches\' travel range. The keyboard gives no on-screen confirmation — the app only knows the command was accepted.'
      : 'This ends calibration mode and returns the keyboard to normal operation. If calibration was never started this still sends the finish command.',
    details: [
      'Device operation — the keyboard may behave differently until calibration finishes.',
      'There is no read-back for this command; the app reports "sent", not "verified".',
      HE_UNVERIFIED_NOTE,
    ],
    impact: {
      affected: ['Whole-keyboard travel calibration'],
      persistent: true,
      backupCaptured: false,
      rollback: 'none',
      // Calibration mode changes how every key reports until finished.
      restartRisk: true,
    },
    confirmLabel: start ? 'Start calibration' : 'Finish calibration',
    danger: start,
  });
  if (!ok) return;
  const session = he?.session;
  if (!session) return;
  busy = true;
  studio?.render();
  try {
    await session.calibration(start);
    setStatus(
      start
        ? 'Calibration start sent — press every key fully on the keyboard, then press Finish calibration.'
        : 'Calibration finish sent — the keyboard returns to normal operation.',
    );
  } catch (e) {
    setStatus(
      `Calibration ${start ? 'start' : 'finish'} failed: ${e instanceof Error ? e.message : String(e)}`,
      true,
    );
  } finally {
    busy = false;
    studio?.render();
  }
}

// ── Page ───────────────────────────────────────────────────────────────

/** Features this page covers, in display order (feature-registry ids). */
const PERF_FEATURES: readonly FeatureId[] = [
  'actuation',
  'rapid-trigger',
  'deadzone',
  'dks-mpt',
  'live-travel',
  'calibration',
];

class PerfStudio {
  readonly el: HTMLElement;
  private unsub: () => void;
  private contextEl: HTMLElement | null = null;
  /** Grid cell elements keyed `row:col` for live-travel paint updates. */
  private cellRefs = new Map<string, { el: HTMLElement; fill: HTMLElement }>();
  private grid: ReturnType<typeof layoutKeyGrid> | null = null;
  private gridCanvas: HTMLElement | null = null;
  private gridViewport: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(root: HTMLElement) {
    root.replaceChildren();
    this.el = el('div', 'perf-page');
    root.append(this.el);
    this.unsub = subscribe(() => this.syncContext());
    this.render();
    if (he && heInfo === null) {
      // Session exists but data load was interrupted — retry quietly.
      void this.loadAll();
    }
  }

  destroy(): void {
    this.unsub();
    this.resizeObserver?.disconnect();
    this.el.remove();
  }

  // ── Data ────────────────────────────────────────────────────────────

  private async loadAll(): Promise<void> {
    if (!he) return;
    try {
      heInfo = await he.session.info();
      slots = await he.session.keySlots();
      heCaps = getCapabilities({
        vendorId: he.device.vendorId,
        productId: he.device.productId,
        usagePage: HE_USAGE_PAGE,
      });
      await loadKeycodes();
    } catch (e) {
      heError = e instanceof Error ? e.message : String(e);
    }
    this.render();
  }

  // ── Render ──────────────────────────────────────────────────────────

  render(): void {
    this.el.replaceChildren();
    this.cellRefs = new Map();
    this.contextEl = null;
    this.grid = null;
    this.gridCanvas = null;
    this.gridViewport = null;

    this.renderContext();

    if (!he) {
      // The context card already carries the connect/unsupported UI.
      return;
    }
    if (he.session.isPoisoned) {
      const c = card('Connection interrupted');
      c.body.append(
        el('p', 'hint', `The link to the keyboard dropped (${he.session.poisonMessage || 'transfer error'}). Reads and writes are paused until you reconnect.`),
      );
      const btn = el('button', 'primary', 'Reconnect HE keyboard');
      btn.type = 'button';
      btn.disabled = busy;
      btn.addEventListener('click', () => void reconnectHe());
      c.body.append(btn);
      this.el.append(c.card);
      return;
    }
    if (!heInfo) {
      const c = card('Reading keyboard…');
      c.body.append(el('p', 'hint', heError || 'Querying device info and key geometry — this takes a moment.'));
      if (heError) {
        const btn = el('button', '', 'Retry');
        btn.type = 'button';
        btn.addEventListener('click', () => {
          heError = '';
          void this.loadAll();
        });
        c.body.append(btn);
      }
      this.el.append(c.card);
      return;
    }
    if (slots.length === 0) {
      const c = card('No key geometry reported');
      c.body.append(
        el(
          'p',
          'hint',
          'The keyboard answered the device-info query but reported no keys in its layout table (command 03 05). Performance editing needs the physical layout — try Refresh or reconnect.',
        ),
      );
      const btn = el('button', '', 'Reload keyboard data');
      btn.type = 'button';
      btn.addEventListener('click', () => void this.loadAll());
      c.body.append(btn);
      this.el.append(c.card);
      return;
    }

    this.renderInfoCard();
    this.renderKeyboardCard();
    this.renderDetail();
    this.renderLiveCard();
    this.renderCalibrationCard();
    this.paintLive();
  }

  /** Top card: which device this page is talking to + capability truth. */
  private renderContext(): void {
    // Rebuild in place — the card is always the first child.
    this.contextEl?.remove();
    const { card: c, body } = card('Performance Studio');
    this.contextEl = c;

    if (he) {
      const dev = he.device;
      const dl = el('dl', 'kv');
      kv(dl, 'Device', dev.productName ?? 'GravaStar HE keyboard');
      if (heInfo) {
        kv(dl, 'Protocol', `HE v2 ${heInfo.protocol}`);
        kv(dl, 'Firmware', heInfo.firmware);
        kv(dl, 'Board', heInfo.boardIdHex);
      }
      body.append(dl);
      body.append(
        el(
          'p',
          'hint',
          'Hall-effect keyboard connected through this page — separate from the main Connect button, which is for khub916 mechanical keyboards.',
        ),
      );
      const row = el('div', 'perf-actions');
      const disc = el('button', '', 'Disconnect HE keyboard');
      disc.type = 'button';
      disc.addEventListener('click', disconnectHe);
      row.append(disc);
      body.append(row);
      c.append(body);
      this.el.prepend(c);
      return;
    }

    // No HE session: decide what to say based on whatever IS connected.
    const like: DeviceLike | null = app.connected
      ? {
          vendorId: app.connected.device.vendorId,
          productId: app.connected.device.productId,
          productName: app.connected.device.productName ?? null,
          uuid: app.snapshot?.info.uuid ?? null,
          catalogModel: app.snapshot?.info.catalogModel ?? null,
          catalogName: app.snapshot?.info.catalogName ?? null,
          screenSize: app.snapshot?.info.screenSize ?? 0,
        }
      : null;
    const caps: CapabilityMap | null = like ? getCapabilities(like) : null;
    const protocol = caps ? protocolOf(like as DeviceLike) : 'unknown';

    if (caps && protocol !== 'he-v2') {
      body.append(
        el(
          'p',
          'coming-soon',
          'This page needs a Hall-effect (HE) keyboard — the connected device does not have one.',
        ),
      );
      const dl = el('dl', 'kv perf-kv');
      for (const f of PERF_FEATURES) {
        const dt = el('dt', '', f.replace(/-/g, ' '));
        dt.dataset.k = f;
        dl.append(dt, el('dd', '', describeFeature(caps, f)));
      }
      body.append(dl);
      body.append(
        el(
          'p',
          'hint',
          'The features above are reported honestly by the capability registry — on a mechanical-switch keyboard they are hardware-impossible, not merely unimplemented.',
        ),
      );
    } else {
      body.append(
        el(
          'p',
          'hint',
          'The Performance Studio configures Hall-effect (magnetic) keyboards: per-key actuation point, rapid trigger, deadzones, DKS/MPT advanced keys, a live travel monitor and calibration. It only works with HE keyboards (GravaStar Mercury V60/V75/K1 HE series over USB).',
        ),
      );
      if (app.connected) {
        body.append(
          el(
            'p',
            'hint',
            'A khub916 keyboard is connected for the other pages — it can stay connected; this page opens its own session for the HE device.',
          ),
        );
      }
    }

    const row = el('div', 'perf-actions');
    const btn = el('button', 'primary', 'Connect HE keyboard');
    btn.type = 'button';
    btn.disabled = busy || !('hid' in navigator);
    btn.title = 'Opens the browser keyboard picker filtered to HE v2 devices';
    btn.addEventListener('click', () => void connectHe());
    row.append(btn);
    if (!('hid' in navigator)) {
      body.append(el('p', 'hint warn', 'This browser cannot talk to keyboards — use Chrome or Edge.'));
    }
    if (heError) body.append(el('p', 'hint warn', heError));
    body.append(row);
    c.append(body);
    this.el.prepend(c);
  }

  /** Cheap refresh of just the context card on app-state emits. */
  private syncContext(): void {
    // Only the no-HE branch depends on app (khub916) state.
    if (!he && this.contextEl?.isConnected) this.renderContext();
  }

  private renderInfoCard(): void {
    const { card: c, body } = card('Keyboard');
    const dl = el('dl', 'kv');
    kv(dl, 'Model', he?.device.productName ?? 'GravaStar HE keyboard');
    if (heInfo) {
      kv(dl, 'Protocol', `HE v2 ${heInfo.protocol}`);
      kv(dl, 'Firmware', heInfo.firmware);
      kv(dl, 'PCB', heInfo.pcb);
      kv(dl, 'Board', heInfo.boardIdHex);
      if (heInfo.buildTime) kv(dl, 'Build', heInfo.buildTime);
    }
    body.append(dl);
    body.append(
      el(
        'p',
        'hint',
        'Physical layout is read from the keyboard itself (command 03 05). ' +
          'Switch travel limits come from each key\'s reported switch id ' +
          '(3.5 mm for UFO switches, 3.4 mm otherwise).',
      ),
    );
    this.el.append(c);
  }

  // ── Keyboard grid + live travel ─────────────────────────────────────

  private renderKeyboardCard(): void {
    const { card: c, body } = card('Keys — click one to edit');
    const grid = layoutKeyGrid(slots);
    this.grid = grid;

    this.gridViewport = el('div', 'kb-viewport perf-viewport');
    this.gridCanvas = el('div', 'kb-canvas');
    this.gridCanvas.style.width = `${grid.width}px`;
    this.gridCanvas.style.height = `${grid.height}px`;
    this.gridViewport.append(this.gridCanvas);
    body.append(this.gridViewport);

    const codes = keycodes;
    for (const cell of grid.cells) {
      const keyEl = el('div', 'kb-key kb-key--idle perf-key');
      keyEl.style.left = `${cell.x}px`;
      keyEl.style.top = `${cell.y}px`;
      keyEl.style.width = `${cell.w}px`;
      keyEl.style.height = `${cell.h}px`;

      const code = codes.get(cell.row)?.[cell.col] ?? 0;
      const label = el('span', 'kb-key-label', heKeyLabel(code));
      const tag = el('span', 'perf-key-tag', `r${cell.row}c${cell.col}`);
      const fill = el('div', 'perf-travel');
      keyEl.append(fill, label, tag);
      keyEl.title = `Matrix r${cell.row} c${cell.col} — ${heKeyLabel(code)} (HID 0x${code.toString(16).toUpperCase().padStart(4, '0')})`;
      if (selected && selected.row === cell.row && selected.col === cell.col) {
        keyEl.classList.add('kb-key--selected');
      }
      keyEl.addEventListener('click', () => void selectKey(cell.row, cell.col));
      this.gridCanvas.append(keyEl);
      this.cellRefs.set(perfKey(cell.row, cell.col), { el: keyEl, fill });
    }

    body.append(
      el(
        'p',
        'hint',
        'Labels come from the layer-0 keymap read (command 03 01). The bar at the bottom of each key shows live travel while the monitor below is running.',
      ),
    );
    this.fitGrid();
    if (typeof ResizeObserver !== 'undefined' && this.gridViewport) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(() => this.fitGrid());
      this.resizeObserver.observe(this.gridViewport);
    }
    c.append(body);
    this.el.append(c);
  }

  private fitGrid(): void {
    if (!this.grid || !this.gridViewport || !this.gridCanvas) return;
    const avail = this.gridViewport.clientWidth;
    const scale = avail > 0 ? Math.min(1, avail / this.grid.width) : 1;
    this.gridCanvas.style.transform = `scale(${scale})`;
    this.gridViewport.style.height = `${this.grid.height * scale}px`;
  }

  // ── Selected-key detail (perf + HK editors) ─────────────────────────

  renderDetail(): void {
    // Remove the previous detail card(s) — they sit between the grid and
    // the live card. Rebuild from scratch; cheap and keeps DOM simple.
    this.el.querySelectorAll('.perf-detail').forEach((n) => n.remove());
    if (!selected || !he || !heCaps) return;

    const { row, col } = selected;
    const perf = perfs.get(perfKey(row, col));
    const banks = hkBanks.get(perfKey(row, col));
    const code = keycodes.get(row)?.[col] ?? 0;

    const wrap = el('div', 'perf-detail');

    // ── Actuation / RT / deadzone editor ────────────────────────────
    const act = card(`Key r${row}c${col} — ${heKeyLabel(code)} · actuation & rapid trigger`);
    act.card.classList.add('perf-detail');
    if (!isFeatureAvailable(heCaps, 'actuation')) {
      act.body.append(
        el('p', 'coming-soon', 'Not available on this device.'),
        el('p', 'hint', describeFeature(heCaps, 'actuation')),
      );
      wrap.append(act.card);
    } else if (detailLoading || !perf) {
      act.body.append(el('p', 'hint', 'Reading the key\'s settings from the keyboard…'));
      wrap.append(act.card);
    } else {
      act.body.append(el('p', 'hint', describeFeature(heCaps, 'actuation')));
      const limit = maxTravelFor(perf.axisV2Id);
      act.body.append(
        el(
          'p',
          'hint',
          `Switch id ${perf.axisV2Id} — max travel ${limit} mm. ` +
            'Switch echo fields (axis/calibration/switch ids) are carried from the read and never edited.',
        ),
      );

      const modeSel = el('select', 'macro-select') as HTMLSelectElement;
      for (const [v, label] of [
        ['0', 'Fixed actuation'],
        ['1', 'Rapid trigger'],
      ] as const) {
        const o = el('option', '', label);
        o.value = v;
        modeSel.append(o);
      }
      modeSel.value = String(perf.mode);

      const normalPress = numInput(String(perf.normalPress));
      const normalRelease = numInput(String(perf.normalRelease));
      const rtFirst = numInput(String(perf.rtFirstTouch));
      const rtPress = numInput(String(perf.rtPress));
      const rtRelease = numInput(String(perf.rtRelease));
      const dzPress = numInput(String(perf.pressDeadzone), '0–1 mm');
      const dzRelease = numInput(String(perf.releaseDeadzone), '0–1 mm');

      const row1 = el('div', 'macro-bind-row');
      row1.append(field('Mode', modeSel));
      row1.append(field('Actuation point (mm)', normalPress));
      row1.append(field('Release point (mm)', normalRelease));
      const row2 = el('div', 'macro-bind-row');
      row2.append(field('RT first touch (mm)', rtFirst));
      row2.append(field('RT press sensitivity (mm)', rtPress));
      row2.append(field('RT release sensitivity (mm)', rtRelease));
      const row3 = el('div', 'macro-bind-row');
      row3.append(field('Press deadzone (mm)', dzPress));
      row3.append(field('Release deadzone (mm)', dzRelease));
      act.body.append(row1, row2, row3);
      act.body.append(
        el(
          'p',
          'hint',
          'Fixed mode uses the actuation/release points; rapid trigger uses first touch + press/release sensitivity. Deadzones are 0–1 mm. Release point is normally 0 (the official driver writes 0).',
        ),
      );

      const readDraft = (): PerfDraft => ({
        mode: Number(modeSel.value),
        normalPress: parseMmInput(normalPress.value) ?? NaN,
        normalRelease: parseMmInput(normalRelease.value) ?? NaN,
        rtFirstTouch: parseMmInput(rtFirst.value) ?? NaN,
        rtPress: parseMmInput(rtPress.value) ?? NaN,
        rtRelease: parseMmInput(rtRelease.value) ?? NaN,
        pressDeadzone: parseMmInput(dzPress.value) ?? NaN,
        releaseDeadzone: parseMmInput(dzRelease.value) ?? NaN,
      });

      const save = el('button', 'primary', 'Save actuation settings');
      save.type = 'button';
      save.disabled = busy;
      save.title = 'Writes the settings to the keyboard and reads them back to verify';
      save.addEventListener('click', () => {
        const d = readDraft();
        const problem = validatePerfDraft(perf, d);
        if (problem) {
          setStatus(`Actuation settings not valid: ${problem}`, true);
          return;
        }
        void savePerf(row, col, d);
      });
      act.body.append(save);
    }
    wrap.append(act.card);

    // ── DKS / MPT advanced-key editor ───────────────────────────────
    const hk = card(`Key r${row}c${col} — advanced function (DKS / MPT)`);
    hk.card.classList.add('perf-detail');
    if (!isFeatureAvailable(heCaps, 'dks-mpt')) {
      hk.body.append(
        el('p', 'coming-soon', 'Not available on this device.'),
        el('p', 'hint', describeFeature(heCaps, 'dks-mpt')),
      );
      wrap.append(hk.card);
    } else {
      hk.body.append(el('p', 'hint', describeFeature(heCaps, 'dks-mpt')));
      if (detailLoading || !banks) {
        hk.body.append(el('p', 'hint', 'Reading advanced-key banks…'));
      } else {
        // Show every stored bank honestly — the cat-6 protocol keeps one
        // config per mode, so a key can hold DKS *and* MPT at once.
        const stored = [...banks.entries()].filter(([, cfg]) => cfg.mode !== 'none');
        if (stored.length === 0) {
          hk.body.append(el('p', 'hint', 'No advanced function stored on this key.'));
        } else {
          const ul = el('ul', 'fact-list');
          for (const [bank, cfg] of stored) {
            ul.append(el('li', '', `${bank.toUpperCase()} bank: ${hkConfigSummary(cfg)}`));
          }
          hk.body.append(ul);
          const other = stored.filter(([bank]) => !HK_EDITABLE_MODES.includes(bank as HkEditableMode));
          if (other.length > 0) {
            hk.body.append(
              el(
                'p',
                'hint',
                'Modes MT/TGL/END/SOCD/RS are stored on the keyboard but are not editable in this page yet — they are shown read-only above.',
              ),
            );
          }
        }
        this.renderHkForm(hk.body, row, col, banks);
      }
    }
    wrap.append(hk.card);

    // Insert before the live-travel card (or append at the end).
    const liveCard = this.el.querySelector('.perf-live-card');
    if (liveCard) this.el.insertBefore(wrap, liveCard);
    else this.el.append(wrap);
  }

  /** DKS/MPT editor form for the selected key. */
  private renderHkForm(
    body: HTMLElement,
    row: number,
    col: number,
    banks: Map<string, HigherKeyConfig>,
  ): void {
    const modeSel = el('select', 'macro-select') as HTMLSelectElement;
    for (const m of HK_EDITABLE_MODES) {
      const o = el('option', '', m === 'none' ? 'None (normal key)' : m.toUpperCase());
      o.value = m;
      modeSel.append(o);
    }
    // Preselect the first non-none editable bank, else 'none'.
    const preset = HK_EDITABLE_MODES.find((m) => m !== 'none' && banks.get(m)?.mode === m) ?? 'none';
    modeSel.value = preset;

    // Keycode inputs — decimal or 0x-hex (HID usage ids).
    const kcInputs: HTMLInputElement[] = [];
    const mkKc = (v: number): HTMLInputElement => {
      const i = textInput(v ? `0x${v.toString(16).toUpperCase()}` : '');
      i.placeholder = '0x04';
      i.title = 'Keycode as HID usage — decimal or 0x-hex (e.g. 4 or 0x04 for A)';
      kcInputs.push(i);
      return i;
    };
    const dksCfg = banks.get('dks');
    const mptCfg = banks.get('mpt');
    const dksKcs = dksCfg?.mode === 'dks' ? dksCfg.params.kcs : [0, 0, 0, 0];
    const mptKcs = mptCfg?.mode === 'mpt' ? mptCfg.params.kcs : [0, 0, 0];

    const grid = el('div', 'perf-hk-grid');
    // DKS row: 4 keycodes + 4 trigger points + 2 deadbands.
    const dksRow = el('div', 'perf-hk-bank');
    dksRow.append(el('p', 'macro-field-label', 'DKS — 4 keycodes, 4 trigger points (0–255), 2 deadbands (mm)'));
    const dksKcWrap = el('div', 'macro-bind-row');
    for (let i = 0; i < 4; i++) dksKcWrap.append(field(`KC${i + 1}`, mkKc(dksKcs[i] ?? 0)));
    const dksNumWrap = el('div', 'macro-bind-row');
    const dksTrp: HTMLInputElement[] = [];
    const dksDb: HTMLInputElement[] = [];
    if (dksCfg?.mode === 'dks') {
      for (let i = 0; i < 4; i++) {
        const inp = numInput(String(dksCfg.params.trps[i] ?? 0));
        inp.step = '1';
        dksTrp.push(inp);
        dksNumWrap.append(field(`TRP${i + 1}`, inp));
      }
      for (let i = 0; i < 2; i++) {
        const inp = numInput(String(dksCfg.params.dbs[i] ?? 0));
        dksDb.push(inp);
        dksNumWrap.append(field(`DB${i + 1} (mm)`, inp));
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const inp = numInput('0');
        inp.step = '1';
        dksTrp.push(inp);
        dksNumWrap.append(field(`TRP${i + 1}`, inp));
      }
      for (let i = 0; i < 2; i++) {
        const inp = numInput('0');
        dksDb.push(inp);
        dksNumWrap.append(field(`DB${i + 1} (mm)`, inp));
      }
    }
    dksRow.append(dksKcWrap, dksNumWrap);

    // MPT row: 3 keycodes + 3 deadbands.
    const mptRow = el('div', 'perf-hk-bank');
    mptRow.append(el('p', 'macro-field-label', 'MPT — 3 keycodes, 3 deadbands (mm)'));
    const mptKcWrap = el('div', 'macro-bind-row');
    const mptKcInputs: HTMLInputElement[] = [];
    for (let i = 0; i < 3; i++) {
      const inp = textInput(mptKcs[i] ? `0x${(mptKcs[i] ?? 0).toString(16).toUpperCase()}` : '');
      inp.placeholder = '0x04';
      inp.title = 'Keycode as HID usage — decimal or 0x-hex';
      mptKcInputs.push(inp);
      mptKcWrap.append(field(`KC${i + 1}`, inp));
    }
    const mptDbWrap = el('div', 'macro-bind-row');
    const mptDb: HTMLInputElement[] = [];
    for (let i = 0; i < 3; i++) {
      const inp = numInput(mptCfg?.mode === 'mpt' ? String(mptCfg.params.dbs[i] ?? 0) : '0');
      mptDb.push(inp);
      mptDbWrap.append(field(`DB${i + 1} (mm)`, inp));
    }
    mptRow.append(mptKcWrap, mptDbWrap);
    grid.append(dksRow, mptRow);
    body.append(grid);

    body.append(
      el(
        'p',
        'hint',
        'DKS/MPT are advanced-key functions stored per mode bank — a key can hold both. ' +
          'Keycodes are HID usage ids (the same numbers the keymap uses). Deadbands are bounded to 0–3.5 mm here (upstream does not bound them). ' +
          'Trigger-point semantics are hardware-unverified.',
      ),
    );

    const save = el('button', 'primary', 'Save advanced-key settings');
    save.type = 'button';
    save.disabled = busy;
    save.addEventListener('click', () => {
      const mode = modeSel.value as HkEditableMode;
      let kcs: number[] = [];
      let nums: number[] = [];
      if (mode === 'dks') {
        kcs = kcInputs.map((i) => parseKcInput(i.value) ?? -1);
        nums = [
          ...dksTrp.map((i) => parseMmInput(i.value) ?? NaN),
          ...dksDb.map((i) => parseMmInput(i.value) ?? NaN),
        ];
      } else if (mode === 'mpt') {
        kcs = mptKcInputs.map((i) => parseKcInput(i.value) ?? -1);
        nums = mptDb.map((i) => parseMmInput(i.value) ?? NaN);
      }
      // Surface parse failures before the generic validator.
      if (mode !== 'none') {
        const badKc = kcs.findIndex((c) => c < 0);
        if (badKc >= 0) {
          setStatus(`Advanced-key settings not valid: keycode ${badKc + 1} is not a number (decimal or 0x-hex)`, true);
          return;
        }
        const badNum = nums.findIndex((n) => !Number.isFinite(n));
        if (badNum >= 0) {
          setStatus('Advanced-key settings not valid: a numeric field is empty or not a number', true);
          return;
        }
      }
      void saveHk(row, col, mode, kcs, nums);
    });
    const clear = el('button', '', 'Clear advanced function');
    clear.type = 'button';
    clear.disabled = busy;
    clear.title = 'Writes mode "none" — the key returns to normal';
    clear.addEventListener('click', () => void saveHk(row, col, 'none', [], []));
    const actions = el('div', 'perf-actions');
    actions.append(save, clear);
    body.append(actions);
  }

  // ── Live travel monitor ─────────────────────────────────────────────

  renderLiveCard(): void {
    this.el.querySelectorAll('.perf-live-card').forEach((n) => n.remove());
    const { card: c, body } = card('Live travel monitor');
    c.classList.add('perf-live-card');

    if (!isFeatureAvailable(heCaps ?? {}, 'live-travel')) {
      body.append(
        el('p', 'coming-soon', 'Not available on this device.'),
        el('p', 'hint', describeFeature(heCaps ?? {}, 'live-travel')),
      );
      this.el.append(c);
      return;
    }
    body.append(el('p', 'hint', describeFeature(heCaps ?? {}, 'live-travel')));
    body.append(
      el(
        'p',
        'hint',
        'Polls commands 04 03 01/03 for every matrix row about 4×/second and fills each key\'s bar with its current travel. Press keys to watch them move — this is a read-only view, nothing is written.',
      ),
    );

    const status = el('p', 'hint perf-live-status');
    const btn = el('button', live.active ? '' : 'primary', live.active ? 'Stop monitor' : 'Start monitor');
    btn.type = 'button';
    btn.disabled = busy || he === null || he?.session.isPoisoned === true;
    btn.addEventListener('click', () => {
      if (live.active) {
        stopLive();
      } else {
        startLive();
      }
      this.renderLiveCard();
    });
    body.append(btn, status);
    c.append(body);
    // Insert before the calibration card (or at the end).
    const cal = this.el.querySelector('.perf-cal-card');
    if (cal) this.el.insertBefore(c, cal);
    else this.el.append(c);
    this.paintLiveStatus();
  }

  private paintLiveStatus(): void {
    const status = this.el.querySelector<HTMLElement>('.perf-live-status');
    if (!status) return;
    if (!live.active) {
      status.textContent = 'Monitor stopped.';
      return;
    }
    if (live.error) {
      status.textContent = `Last poll failed: ${live.error}`;
      status.classList.add('warn');
      return;
    }
    status.classList.remove('warn');
    const parts = activeRows().map((r) => {
      const keys = live.rows.get(r);
      return keys ? `row ${r}: ${liveRowSummary(keys)}` : `row ${r}: —`;
    });
    status.textContent = parts.join(' · ');
  }

  /** Push the latest live-travel readings into the grid overlays. */
  paintLive(): void {
    if (!heCaps || !isFeatureAvailable(heCaps, 'live-travel')) return;
    for (const [k, ref] of this.cellRefs) {
      const parts = k.split(':');
      const r = Number(parts[0]);
      const cIdx = Number(parts[1]);
      const keys = live.rows.get(r);
      const key = keys?.[cIdx];
      if (!key) {
        ref.fill.style.height = '0%';
        ref.el.classList.remove('perf-key--actuated');
        continue;
      }
      const max = maxTravelFor(perfs.get(k)?.axisV2Id ?? 0);
      ref.fill.style.height = `${travelFill(key.travelMm, max || 3.4) * 100}%`;
      ref.el.classList.toggle('perf-key--actuated', key.actuated);
    }
    this.paintLiveStatus();
  }

  // ── Calibration ─────────────────────────────────────────────────────

  renderCalibrationCard(): void {
    this.el.querySelectorAll('.perf-cal-card').forEach((n) => n.remove());
    const { card: c, body } = card('Travel calibration');
    c.classList.add('perf-cal-card');

    if (!isFeatureAvailable(heCaps ?? {}, 'calibration')) {
      body.append(
        el('p', 'coming-soon', 'Not available on this device.'),
        el('p', 'hint', describeFeature(heCaps ?? {}, 'calibration')),
      );
      this.el.append(c);
      return;
    }
    body.append(el('p', 'hint', describeFeature(heCaps ?? {}, 'calibration')));
    body.append(
      el(
        'p',
        'hint',
        'Calibration makes the keyboard learn each switch\'s full travel range. ' +
          'Start it, then press every key fully and release it on the physical keyboard; ' +
          'finish when done. The procedure itself runs on the device — this page only sends the start/finish commands, and the keyboard gives no confirmation back.',
      ),
    );
    const row = el('div', 'perf-actions');
    const start = el('button', 'primary', 'Start calibration');
    start.type = 'button';
    start.disabled = busy || he === null || he?.session.isPoisoned === true;
    start.addEventListener('click', () => void runCalibration(true));
    const finish = el('button', '', 'Finish calibration');
    finish.type = 'button';
    finish.disabled = busy || he === null || he?.session.isPoisoned === true;
    finish.addEventListener('click', () => void runCalibration(false));
    row.append(start, finish);
    body.append(row);
    body.append(
      el(
        'p',
        'hint warn',
        'Device operation (level 3): the keyboard changes behaviour until calibration finishes. ' +
          HE_UNVERIFIED_NOTE,
      ),
    );
    c.append(body);
    this.el.append(c);
  }
}

// ── Router hooks ───────────────────────────────────────────────────────

let studio: PerfStudio | null = null;

export function renderPerfPage(root: HTMLElement): void {
  if (studio && studio.el.isConnected) return;
  studio?.destroy();
  studio = new PerfStudio(root);
}

export function destroyPerfPage(): void {
  stopLive();
  studio?.destroy();
  studio = null;
  // The HE session deliberately survives — the HID permission is still
  // granted and re-entering the page should not force a re-pick.
}
