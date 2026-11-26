/**
 * Connection slice of the shared application state — device connect /
 * disconnect / refresh / auto-reconnect and the read-only snapshot
 * loader. Queries run SEQUENTIALLY: concurrent feature reports
 * interleave responses on this firmware and poison the session.
 */

import {
  getRememberedDevices,
  kindOf,
  openKhub916,
  reopenKhub916,
  requestKhubDevice,
  type ConnectedKhub,
  type Khub916Session,
} from '../hid.ts';
import {
  deviceIdentity,
  loadLastDevice,
  orderByLastUsed,
  sameDevice,
  saveLastDevice,
} from '../conn-core.ts';
import { app, emit, setStatus, type DeviceSnapshot } from './core.ts';
import { ensureKeymap } from './keymap.ts';

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
    app.connectStage = 'picker';
    emit();
    const device = await requestKhubDevice();
    app.connectStage = 'connecting';
    emit();
    if (!device) {
      setStatus('Keyboard picker closed — press Connect to try again.');
      return;
    }
    setStatus('Connecting…');
    app.connected = await openKhub916(device);
    app.deviceLabel = labelFor(app.connected, null);
    // Remember this unit (vid/pid/serial — serial is for matching only,
    // never displayed) so auto-connect prefers it next boot.
    saveLastDevice(deviceIdentity(device));
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
    app.connectStage = 'idle';
    emit();
  }
}

export async function disconnect(): Promise<void> {
  const c = app.connected;
  app.connected = null;
  app.snapshot = null;
  app.deviceLabel = '';
  app.reconnectedSilently = false;
  app.connectStage = 'idle';
  await c?.device.close().catch(() => {});
  setStatus('Disconnected.');
}

/**
 * Open a granted HIDDevice as a READ-ONLY session: the snapshot loads
 * immediately, but every write stays blocked until the user explicitly
 * approves this session (`enableEditing` or a fresh manual Connect).
 * Shared by boot auto-connect and the HID 'connect' hot-plug path.
 * Returns true when a live session is up.
 */
async function openSilentSession(device: HIDDevice): Promise<boolean> {
  app.connected = await openKhub916(device);
  app.deviceLabel = labelFor(app.connected, null);
  app.connected.session.writesBlocked = true;
  app.reconnectedSilently = true;
  saveLastDevice(deviceIdentity(device));
  await refresh();
  return app.connected !== null;
}

/**
 * The single explicit user action that unlocks writes after a silent
 * connect — the "Enable editing" banner button. Clears the session's
 * write gate in place; no reconnect needed. Safety contract: nothing is
 * ever written without this gesture (or an equivalent manual Connect).
 */
export function enableEditing(): void {
  const c = app.connected;
  if (c && c.session.writesBlocked) {
    c.session.writesBlocked = false;
    app.reconnectedSilently = false;
    setStatus(`Editing enabled — changes to ${app.deviceLabel || 'the keyboard'} will be saved.`);
    return;
  }
  app.reconnectedSilently = false;
  emit();
}

/**
 * WebHID 'connect' event: a GravaStar wired keyboard appeared. Auto-open
 * a read-only session ONLY for devices the browser already granted — an
 * unknown device still needs the Connect picker (a user gesture), so we
 * never prompt from a hot-plug event.
 */
export async function handleHidConnect(device: HIDDevice): Promise<void> {
  if (!('hid' in navigator) || app.busy || app.connected) return;
  if (kindOf(device.vendorId, device.productId) !== 'wired') return;
  const granted = await getRememberedDevices().catch(() => [] as HIDDevice[]);
  const mine = deviceIdentity(device);
  if (!granted.some((d) => sameDevice(mine, d))) return;
  app.busy = true;
  app.connectStage = 'connecting';
  setStatus('Keyboard detected — connecting read-only…');
  emit();
  try {
    await openSilentSession(device);
  } catch {
    app.connected = null;
    app.snapshot = null;
    app.deviceLabel = '';
    app.reconnectedSilently = false;
  } finally {
    app.busy = false;
    app.connectStage = 'idle';
    emit();
  }
}

/**
 * WebHID 'disconnect' event: the active keyboard went away — drop the
 * session immediately so no stale snapshot survives and nothing queued
 * can write to a dead handle. The remembered identity is kept, so
 * re-plugging (or the next boot) auto-connects again.
 */
export function handleHidDisconnect(device: HIDDevice): void {
  const c = app.connected;
  if (!c) return;
  if (!sameDevice(deviceIdentity(c.device), device)) return;
  void disconnect();
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
      ? `Read-only — ${label} connected. Press "Enable editing" to allow changes.`
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
  // Prefer the last-used unit when several authorised keyboards exist.
  const candidates = orderByLastUsed(
    remembered.filter((d) => kindOf(d.vendorId, d.productId) === 'wired'),
    loadLastDevice(),
  );
  if (candidates.length === 0) return;
  app.busy = true;
  app.connectStage = 'connecting';
  setStatus('Reconnecting keyboard…');
  emit();
  try {
    for (const device of candidates) {
      try {
        if (await openSilentSession(device)) return;
      } catch {
        // try the next remembered device
      }
    }
    app.reconnectedSilently = false;
    setStatus('Could not find the keyboard — press Connect to pick it.');
  } finally {
    app.busy = false;
    app.connectStage = 'idle';
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
  const wired = remembered.filter((d) => kindOf(d.vendorId, d.productId) === 'wired');
  setStatus(
    wired.length > 0
      ? 'Welcome back! Looking for your keyboard…'
      : 'Ready. Plug in your GravaStar keyboard with a USB cable, then press Connect keyboard below.',
  );
}
