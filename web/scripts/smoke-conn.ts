/**
 * Node smoke test for the connection-lifecycle core (`src/conn-core.ts`)
 * — device identity, last-used ordering and localStorage persistence.
 *
 * DOM-free by design: the HID event wiring (device-events.ts) and the
 * session logic (state/connection.ts) are exercised on hardware; this
 * covers the decision/persistence layer. Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 */

declare const process: { exit(code?: number): never };

import {
  LAST_DEVICE_STORAGE_KEY,
  deviceIdentity,
  identityScore,
  loadLastDevice,
  orderByLastUsed,
  sameDevice,
  saveLastDevice,
  type DeviceLike,
  type KeyValueStorage,
} from '../src/conn-core.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

/** In-memory Storage stand-in. */
class MemStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const VID = 0x258a;
const PID = 0x010c;
const OTHER_PID = 0x0297;

// ── deviceIdentity ─────────────────────────────────────────────────────

{
  const id = deviceIdentity({ vendorId: VID, productId: PID, serialNumber: 'SN-1' });
  check('identity keeps serial', id.serialNumber === 'SN-1');
  check('identity vid/pid', id.vendorId === VID && id.productId === PID);

  check('empty serial → null', deviceIdentity({ vendorId: VID, productId: PID, serialNumber: '' }).serialNumber === null);
  check('missing serial → null', deviceIdentity({ vendorId: VID, productId: PID }).serialNumber === null);
  check('null serial → null', deviceIdentity({ vendorId: VID, productId: PID, serialNumber: null }).serialNumber === null);
}

// ── sameDevice / identityScore ─────────────────────────────────────────

{
  const remembered = deviceIdentity({ vendorId: VID, productId: PID, serialNumber: 'SN-1' });

  check('exact match', sameDevice(remembered, { vendorId: VID, productId: PID, serialNumber: 'SN-1' }));
  check('score exact = 2', identityScore(remembered, { vendorId: VID, productId: PID, serialNumber: 'SN-1' }) === 2);

  // A different serial on the same VID:PID is a DIFFERENT physical unit.
  check('serial mismatch → not same', !sameDevice(remembered, { vendorId: VID, productId: PID, serialNumber: 'SN-2' }));
  check('serial mismatch score = 0', identityScore(remembered, { vendorId: VID, productId: PID, serialNumber: 'SN-2' }) === 0);

  // Missing serial on either side falls back to VID:PID.
  check('device w/o serial still matches', sameDevice(remembered, { vendorId: VID, productId: PID }));
  check('remembered w/o serial matches serial device', sameDevice(
    deviceIdentity({ vendorId: VID, productId: PID }),
    { vendorId: VID, productId: PID, serialNumber: 'SN-9' },
  ));
  check('vid/pid mismatch → not same', !sameDevice(remembered, { vendorId: VID, productId: OTHER_PID, serialNumber: 'SN-1' }));
  check('vid mismatch → not same', !sameDevice(remembered, { vendorId: 0x379a, productId: PID, serialNumber: 'SN-1' }));
}

// ── Persistence round-trip ─────────────────────────────────────────────

{
  const store = new MemStorage();
  check('empty storage → null', loadLastDevice(store) === null);

  saveLastDevice(deviceIdentity({ vendorId: VID, productId: PID, serialNumber: 'SN-1' }), store);
  const back = loadLastDevice(store);
  check('roundtrip identity', back !== null && back.vendorId === VID && back.productId === PID && back.serialNumber === 'SN-1');
  check('stored under expected key', store.getItem(LAST_DEVICE_STORAGE_KEY) !== null);

  // Corrupt / malformed payloads degrade to null, never throw.
  store.setItem(LAST_DEVICE_STORAGE_KEY, 'not json{');
  check('corrupt json → null', loadLastDevice(store) === null);
  store.setItem(LAST_DEVICE_STORAGE_KEY, '{"vendorId":"x"}');
  check('wrong types → null', loadLastDevice(store) === null);
  store.setItem(LAST_DEVICE_STORAGE_KEY, '{"vendorId":9610,"productId":269,"serialNumber":42}');
  const partial = loadLastDevice(store);
  check('bad serial coerced to null', partial !== null && partial.serialNumber === null);

  check('null storage → null', loadLastDevice(null) === null);
}

// ── orderByLastUsed ────────────────────────────────────────────────────

{
  const a: DeviceLike = { vendorId: VID, productId: PID, serialNumber: 'A' };
  const b: DeviceLike = { vendorId: VID, productId: OTHER_PID, serialNumber: 'B' };
  const c: DeviceLike = { vendorId: VID, productId: PID, serialNumber: 'C' };
  const last = deviceIdentity({ vendorId: VID, productId: OTHER_PID, serialNumber: 'B' });

  const ordered = orderByLastUsed([a, b, c], last);
  check('last-used first', ordered[0] === b);
  check('others keep relative order', ordered[1] === a && ordered[2] === c);

  // Serial-known last identity must NOT promote a same-VID:PID unit with
  // a different serial above unrelated devices… it scores 0 like the rest.
  const lastSerial = deviceIdentity({ vendorId: VID, productId: PID, serialNumber: 'Z' });
  const ordered2 = orderByLastUsed([a, b, c], lastSerial);
  check('serial mismatch keeps order', ordered2[0] === a && ordered2[1] === b && ordered2[2] === c);

  check('null last → copy in order', (() => {
    const out = orderByLastUsed([a, b], null);
    return out[0] === a && out[1] === b && out !== undefined;
  })());
  check('single device passthrough', orderByLastUsed([a], last)[0] === a);
  check('empty list', orderByLastUsed([], last).length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke-conn: all checks passed');
