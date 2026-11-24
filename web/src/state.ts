/**
 * Shared application state for the khub916 configurator shell.
 *
 * One connected device + one read snapshot (info/power/profile/lights/
 * keymaps) lives here; pages subscribe via `subscribe()` and re-render.
 * READ-ONLY: only query commands are issued (spec §6).
 */

import {
  getRememberedDevices,
  kindOf,
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
  status: 'Getting ready…',
  statusError: false,
  /** True while a connect/refresh is in flight. */
  busy: false,
  /**
   * True while the Music page is streaming cmd-8 frames. Other pages
   * show a "music mode active" banner; the stream always restores the
   * previous lighting on stop (see music.ts).
   */
  musicActive: false,
  /**
   * True after a SILENT reconnect — auto-connect on page load or poison
   * recovery inside `refresh()`. The session's writes are blocked until
   * the user connects manually again, so nothing queued before the
   * reconnect is ever applied without an explicit re-approval (R6).
   */
  reconnectedSilently: false,
  /** "Product name — Model" label for the topbar/status (e.g. "Gaming Keyboard — K1 Pro"). */
  deviceLabel: '',
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
    setStatus(`Could not read the keymap: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// ── Connect / disconnect / refresh ─────────────────────────────────────

/**
 * Human-readable "Product — Model" for the connected device. The HID
 * product name comes from the descriptor ("Gaming Keyboard"); the model
 * comes from the cmd-130 catalog lookup once the snapshot is loaded.
 */
function labelFor(c: ConnectedKhub, snap: DeviceSnapshot | null): string {
  const product =
    c.device.productName?.trim() ||
    c.device.manufacturerName?.trim() ||
    'GravaStar keyboard';
  const model = snap?.info.catalogName ?? snap?.info.catalogModel ?? null;
  return model ? `${product} — ${model}` : product;
}

export async function connect(): Promise<void> {
  if (app.busy) return;
  app.busy = true;
  emit();
  try {
    setStatus('Pick your keyboard in the browser window…');
    const device = await requestKhubDevice();
    if (!device) {
      setStatus('Keyboard picker closed — press Connect to try again.');
      return;
    }
    setStatus('Connecting…');
    app.connected = await openKhub916(device);
    app.deviceLabel = labelFor(app.connected, null);
    // A manual connect is the explicit re-approval that lifts the silent-
    // reconnect write gate (R6); the fresh session starts unblocked.
    app.reconnectedSilently = false;
    await refresh();
  } catch (e) {
    app.connected = null;
    app.snapshot = null;
    app.deviceLabel = '';
    app.reconnectedSilently = false;
    setStatus(`Could not connect: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    app.busy = false;
    emit();
  }
}

export async function disconnect(): Promise<void> {
  const c = app.connected;
  app.connected = null;
  app.snapshot = null;
  app.deviceLabel = '';
  app.reconnectedSilently = false;
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
  setStatus('Reading your keyboard…');
  emit();
  try {
    app.snapshot = await loadSnapshot(c.session);
  } catch (e) {
    // A poisoned session is recoverable: reopen the same (already
    // authorised) HIDDevice and retry once before bothering the user.
    if (c.session.isPoisoned) {
      setStatus('Connection hiccup — reconnecting…');
      try {
        c = await reopenKhub916(c.device);
        // This reopen happens without a user gesture: gate writes until
        // the user re-approves (R6). Reads/refresh keep working.
        c.session.writesBlocked = true;
        app.reconnectedSilently = true;
        app.connected = c;
        app.snapshot = await loadSnapshot(c.session);
      } catch (e2) {
        app.connected = null;
        app.snapshot = null;
        app.deviceLabel = '';
        app.reconnectedSilently = false;
        const reason = c.session.poisonMessage || (e2 instanceof Error ? e2.message : String(e2));
        setStatus(`Lost the connection (${reason}) — please press Connect again.`, true);
        app.busy = false;
        emit();
        return;
      }
    } else {
      setStatus(`Could not read the keyboard: ${e instanceof Error ? e.message : String(e)}`, true);
      app.busy = false;
      emit();
      return;
    }
  }
  if (app.connected) {
    app.deviceLabel = labelFor(app.connected, app.snapshot);
  }
  const label = app.deviceLabel || 'keyboard';
  setStatus(
    app.reconnectedSilently
      ? `Reconnected — ${label}. Nothing was changed; press Disconnect, then Connect, to make changes.`
      : `Ready — ${label} connected.`,
  );
  // Warm the current layer so the visualizer has labels immediately.
  await ensureKeymap(app.layer).catch(() => {});
  app.busy = false;
  emit();
}

/**
 * Auto-reconnect on page load: WebHID permissions persist per origin, so a
 * previously authorised khub916 device can be re-opened without any user
 * gesture. Tries each remembered wired device until one opens.
 */
export async function autoConnect(): Promise<void> {
  if (app.busy || app.connected || !('hid' in navigator)) return;
  const remembered = await getRememberedDevices().catch(() => [] as HIDDevice[]);
  const candidates = remembered.filter((d) => kindOf(d.vendorId, d.productId) === 'wired');
  if (candidates.length === 0) return;
  app.busy = true;
  setStatus('Reconnecting keyboard…');
  emit();
  try {
    for (const device of candidates) {
      try {
        app.connected = await openKhub916(device);
        app.deviceLabel = labelFor(app.connected, null);
        // Silent reconnect: gate all writes until the user explicitly
        // re-approves (Disconnect → Connect). Reads/refresh still work.
        app.connected.session.writesBlocked = true;
        app.reconnectedSilently = true;
        await refresh();
        return;
      } catch {
        // try the next remembered device
      }
    }
    app.reconnectedSilently = false;
    setStatus('Could not find the keyboard — press Connect to pick it.');
  } finally {
    app.busy = false;
    emit();
  }
}

/** Boot check: WebHID presence + previously granted devices. */
export async function bootStatus(): Promise<void> {
  if (!('hid' in navigator)) {
    setStatus('This browser cannot talk to keyboards. Please use Chrome or Edge on a computer.', true);
    return;
  }
  const remembered = await getRememberedDevices().catch(() => [] as HIDDevice[]);
  setStatus(
    remembered.length > 0
      ? 'Welcome back! Press Connect to pick your keyboard.'
      : 'Ready. Plug in your GravaStar keyboard with a USB cable, then press Connect keyboard below.',
  );
}
