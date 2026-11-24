/**
 * Shared application state for the khub916 configurator shell.
 *
 * One connected device + one read snapshot (info/power/profile/lights/
 * keymaps) lives here; pages subscribe via `subscribe()` and re-render.
 * READ-ONLY: only query commands are issued (spec §6).
 */

import {
  getRememberedDevices,
  openKhub916,
  reopenKhub916,
  requestKhubDevice,
  type ConnectedKhub,
  type Khub916Session,
} from './hid.ts';
import {
  decodeKeyValue,
  keyValueLabel,
  type DeviceInfo,
  type KeyValue,
  type LightColor,
  type PowerInfo,
  type ProfileInfo,
} from './proto/khub916.ts';

export interface KeyEntry {
  value: number;
  kv: KeyValue;
  label: string;
}

export interface DeviceSnapshot {
  info: DeviceInfo;
  power: PowerInfo;
  profile: ProfileInfo;
  /** cmd 138 per-mode blob (~480 B, raw). */
  lightData: Uint8Array;
  /** cmd 133 macro region (raw). */
  macro: Uint8Array;
  /** cmd 134 custom light colours, 126 entries (`pos = 8 + i*4`). */
  colors: LightColor[];
  /** Decoded keymaps cached per arg (layer 0–3 / system bit). */
  keymaps: Map<number, KeyEntry[]>;
}

export const app = {
  connected: null as ConnectedKhub | null,
  snapshot: null as DeviceSnapshot | null,
  /** Currently selected keymap layer arg (0–3; system bit stays 0). */
  layer: 0,
  status: 'Checking WebHID support…',
  statusError: false,
  /** True while a connect/refresh is in flight. */
  busy: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  for (const fn of listeners) fn();
}

export function setStatus(msg: string, isError = false): void {
  app.status = msg;
  app.statusError = isError;
  emit();
}

// ── Keymap ─────────────────────────────────────────────────────────────

/** Fetch + cache the decoded keymap for one arg. No-op when cached. */
export async function ensureKeymap(arg: number): Promise<KeyEntry[]> {
  const snap = app.snapshot;
  if (!snap || !app.connected) return [];
  const cached = snap.keymaps.get(arg);
  if (cached) return cached;
  const keys = await app.connected.session.keymap(arg);
  snap.keymaps.set(arg, keys);
  emit();
  return keys;
}

export async function setLayer(layer: number): Promise<void> {
  app.layer = layer & 3;
  emit();
  try {
    await ensureKeymap(app.layer);
  } catch (e) {
    setStatus(`Keymap read failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// ── Connect / disconnect / refresh ─────────────────────────────────────

export async function connect(): Promise<void> {
  if (app.busy) return;
  app.busy = true;
  emit();
  try {
    setStatus('Select your GravaStar keyboard…');
    const device = await requestKhubDevice();
    if (!device) {
      setStatus('No device selected.');
      return;
    }
    setStatus('Opening device and probing report id…');
    app.connected = await openKhub916(device);
    await refresh();
  } catch (e) {
    app.connected = null;
    app.snapshot = null;
    setStatus(`Connect failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    app.busy = false;
    emit();
  }
}

export async function disconnect(): Promise<void> {
  const c = app.connected;
  app.connected = null;
  app.snapshot = null;
  await c?.device.close().catch(() => {});
  setStatus('Disconnected.');
}

/**
 * Read the full snapshot. Queries run SEQUENTIALLY — concurrent feature
 * reports interleave responses on this firmware and poison the session.
 */
async function loadSnapshot(session: Khub916Session): Promise<DeviceSnapshot> {
  const info = await session.deviceInfo();
  const power = await session.power();
  const profile = await session.profile();
  const lightData = await session.lightColorData();
  const macro = await session.macroRegion();
  const colors = await session.customLightColors();
  return { info, power, profile, lightData, macro, colors, keymaps: new Map() };
}

export async function refresh(): Promise<void> {
  let c = app.connected;
  if (!c) return;
  app.busy = true;
  setStatus('Reading device…');
  emit();
  try {
    app.snapshot = await loadSnapshot(c.session);
  } catch (e) {
    // A poisoned session is recoverable: reopen the same (already
    // authorised) HIDDevice and retry once before bothering the user.
    if (c.session.isPoisoned) {
      setStatus('Device session dropped — reopening…');
      try {
        c = await reopenKhub916(c.device);
        app.connected = c;
        app.snapshot = await loadSnapshot(c.session);
      } catch (e2) {
        app.connected = null;
        app.snapshot = null;
        const reason = c.session.poisonMessage || (e2 instanceof Error ? e2.message : String(e2));
        setStatus(`Session lost (${reason}) — please reconnect.`, true);
        app.busy = false;
        emit();
        return;
      }
    } else {
      setStatus(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, true);
      app.busy = false;
      emit();
      return;
    }
  }
  setStatus(`Connected — ${app.snapshot.info.catalogName ?? app.snapshot.info.uuid}`);
  // Warm the current layer so the visualizer has labels immediately.
  await ensureKeymap(app.layer).catch(() => {});
  app.busy = false;
  emit();
}

/** Boot check: WebHID presence + previously granted devices. */
export async function bootStatus(): Promise<void> {
  if (!('hid' in navigator)) {
    setStatus('WebHID is not available in this browser. Use Chrome or Edge (desktop).', true);
    return;
  }
  const remembered = await getRememberedDevices().catch(() => [] as HIDDevice[]);
  setStatus(
    remembered.length > 0
      ? `${remembered.length} previously authorised device(s) found — use Connect to pick one.`
      : 'WebHID ready. Connect a khub916 keyboard (K1 / K98 series, USB cable).',
  );
}
