/**
 * oh-my-gravastar web UI — single-page read-only khub916 client.
 *
 * Flow: requestDevice → openKhub916 (collection pick + report-id probe)
 * → device info / power / profile / keymap / custom light colours.
 * All commands are queries (spec §6); nothing is written to the keyboard.
 */

import {
  formatVidPid,
  getRememberedDevices,
  openKhub916,
  requestKhubDevice,
  type ConnectedKhub,
} from './hid.ts';
import type { LightColor } from './proto/khub916.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const statusEl = $<HTMLElement>('status');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const refreshBtn = $<HTMLButtonElement>('refresh');

let connected: ConnectedKhub | null = null;
let currentLayer = 0;

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function show(id: string): void {
  $(id).hidden = false;
}

function hide(id: string): void {
  $(id).hidden = true;
}

function kvRow(dl: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

function clear(el: HTMLElement): void {
  el.replaceChildren();
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderDeviceInfo(c: ConnectedKhub, info: Awaited<ReturnType<ConnectedKhub['session']['deviceInfo']>>): void {
  const dl = $('device-info');
  clear(dl);
  kvRow(dl, 'Model', info.catalogName ?? 'Unknown (UUID not in catalog)');
  kvRow(dl, 'Model id', info.catalogModel ?? '—');
  kvRow(dl, 'UUID', info.uuid);
  kvRow(dl, 'Firmware', info.versionHex);
  kvRow(dl, 'Screen', info.screen ? `${info.screen[0]}×${info.screen[1]} (code ${info.screenSize})` : 'none');
  kvRow(dl, 'Transport', `${c.kind} · reportId ${c.reportId} · usagePage 0x${c.collection.usagePage.toString(16).toUpperCase()}`);
  kvRow(dl, 'HID', `${formatVidPid(c.device)} · ${c.device.productName ?? c.device.manufacturerName ?? ''}`);
  show('device-card');
}

function renderPower(power: { percent: number; flags: number }): void {
  const dl = $('device-info');
  // Replace or append the battery row.
  const existing = dl.querySelector('dt[data-k="battery"]');
  if (existing) existing.nextElementSibling?.remove();
  existing?.remove();
  const dt = document.createElement('dt');
  dt.textContent = 'Battery';
  dt.dataset.k = 'battery';
  const dd = document.createElement('dd');
  dd.textContent = `${power.percent}% (flags 0x${power.flags.toString(16).padStart(2, '0').toUpperCase()})`;
  dl.append(dt, dd);
}

function renderKeymap(
  keys: { value: number; label: string }[],
  arg: number,
): void {
  $('keymap-arg').textContent = `arg=0x${arg.toString(16).padStart(2, '0')} · ${keys.length} entries`;
  const grid = $('keymap-grid');
  clear(grid);
  keys.forEach((k, i) => {
    const cell = document.createElement('div');
    cell.className = 'key';
    cell.title = `#${i} = 0x${k.value.toString(16).toUpperCase().padStart(8, '0')}`;
    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = k.label || '·';
    const idx = document.createElement('span');
    idx.className = 'key-idx';
    idx.textContent = String(i);
    cell.append(label, idx);
    grid.append(cell);
  });
  show('keymap-card');
}

function renderLayerButtons(): void {
  const box = $('layer-buttons');
  clear(box);
  for (let layer = 0; layer < 4; layer++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Layer ${layer}`;
    b.className = layer === currentLayer ? 'active' : '';
    b.addEventListener('click', () => {
      currentLayer = layer;
      renderLayerButtons();
      void loadKeymap();
    });
    box.append(b);
  }
}

function renderLights(colors: LightColor[]): void {
  const grid = $('light-grid');
  clear(grid);
  for (const c of colors) {
    const cell = document.createElement('div');
    cell.className = 'swatch';
    cell.style.background = `rgb(${c.r},${c.g},${c.b})`;
    cell.title = `#${c.index} pos=${c.pos} rgb(${c.r},${c.g},${c.b})`;
    grid.append(cell);
  }
  show('lights-card');
}

function renderRaw(
  profile: { raw: Uint8Array; lightMode: number | null; sleepSeconds: number | null },
  lightData: Uint8Array,
  macro: Uint8Array,
): void {
  const dl = $('raw-info');
  clear(dl);
  kvRow(dl, 'Profile blob', `${profile.raw.length} bytes`);
  kvRow(dl, 'Light mode', profile.lightMode !== null ? `0x${profile.lightMode.toString(16).padStart(4, '0')}` : '—');
  kvRow(dl, 'Sleep time', profile.sleepSeconds !== null ? `${profile.sleepSeconds} s` : '—');
  kvRow(dl, 'Light data (138)', `${lightData.length} bytes (raw — per-mode RGB groups not decoded yet)`);
  kvRow(dl, 'Macro region (133)', `${macro.length} bytes (raw — header semantics unproven, spec §6)`);
  show('raw-card');
}

// ── Loading ────────────────────────────────────────────────────────────

async function loadKeymap(): Promise<void> {
  if (!connected) return;
  const arg = currentLayer & 3; // system bit (<<2) left at 0 for MVP
  const keys = await connected.session.keymap(arg);
  renderKeymap(keys, arg);
}

async function refreshAll(): Promise<void> {
  if (!connected) return;
  setStatus('Reading device…');
  const s = connected.session;
  const [info, power, profile, lightData, macro, colors] = await Promise.all([
    s.deviceInfo(),
    s.power(),
    s.profile(),
    s.lightColorData(),
    s.macroRegion(),
    s.customLightColors(),
  ]);
  renderDeviceInfo(connected, info);
  renderPower(power);
  renderRaw(profile, lightData, macro);
  renderLights(colors);
  renderLayerButtons();
  await loadKeymap();
  setStatus(`Connected — ${info.catalogName ?? info.uuid}`);
}

// ── Wiring ─────────────────────────────────────────────────────────────

connectBtn.addEventListener('click', () => {
  void (async () => {
    connectBtn.disabled = true;
    try {
      setStatus('Select your GravaStar keyboard…');
      const device = await requestKhubDevice();
      if (!device) {
        setStatus('No device selected.');
        return;
      }
      setStatus('Opening device and probing report id…');
      connected = await openKhub916(device);
      disconnectBtn.hidden = false;
      refreshBtn.hidden = false;
      connectBtn.hidden = true;
      await refreshAll();
    } catch (e) {
      connected = null;
      setStatus(`Connect failed: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      connectBtn.disabled = false;
    }
  })();
});

disconnectBtn.addEventListener('click', () => {
  void connected?.device.close().catch(() => {});
  connected = null;
  connectBtn.hidden = false;
  disconnectBtn.hidden = true;
  refreshBtn.hidden = true;
  for (const id of ['device-card', 'keymap-card', 'lights-card', 'raw-card']) hide(id);
  setStatus('Disconnected.');
});

refreshBtn.addEventListener('click', () => {
  void refreshAll().catch((e) => {
    setStatus(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, true);
    // Poisoned sessions need a reconnect.
    if (connected?.session.isPoisoned) {
      connected = null;
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
      refreshBtn.hidden = true;
      setStatus('Session poisoned — please reconnect.', true);
    }
  });
});

// ── Boot ───────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  if (!('hid' in navigator)) {
    setStatus(
      'WebHID is not available in this browser. Use Chrome or Edge (desktop).',
      true,
    );
    connectBtn.disabled = true;
    return;
  }
  setStatus('WebHID ready. Connect a khub916 keyboard (K1 / K98 series, USB cable).');
  // Offer reconnect for previously granted devices.
  const remembered = await getRememberedDevices().catch(() => [] as HIDDevice[]);
  if (remembered.length > 0) {
    setStatus(
      `${remembered.length} previously authorised device(s) found — use Connect to pick one.`,
    );
  }
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline cache is best-effort */
    });
  }
}

void boot();
