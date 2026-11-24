/**
 * Shared application state core for the khub916 configurator shell.
 *
 * The `app` store, pub/sub plumbing and snapshot types live here; domain
 * slices (`keymap.ts`, `connection.ts`) import from this module and the
 * `../state.ts` barrel re-exports everything.
 *
 * READ-ONLY: only query commands are issued (spec §6).
 */

import type { ConnectedKhub } from '../hid.ts';
import type {
  DeviceInfo,
  KeyValue,
  LightColor,
  PowerInfo,
  ProfileInfo,
} from '../proto/khub916.ts';

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
