/**
 * WebHID device hot-plug events — `connect` / `disconnect` on
 * `navigator.hid` (the HID interface is an EventTarget; Chrome/Edge fire
 * these for granted AND ungranted devices).
 *
 * Kept deliberately thin: every decision lives in
 * `state/connection.ts` (`handleHidConnect` / `handleHidDisconnect`) so
 * the session logic stays reviewable in one place.
 */

import { handleHidConnect, handleHidDisconnect } from './state/connection.ts';

let installed = false;

/**
 * Subscribe to HID connect/disconnect events once. Idempotent — safe to
 * call on every shell mount.
 */
export function installHidDeviceEvents(): void {
  if (installed || !('hid' in navigator)) return;
  installed = true;
  navigator.hid.addEventListener('connect', (e) => {
    const device = (e as HIDConnectEvent).device;
    if (device) void handleHidConnect(device);
  });
  navigator.hid.addEventListener('disconnect', (e) => {
    const device = (e as HIDConnectEvent).device;
    if (device) handleHidDisconnect(device);
  });
}
