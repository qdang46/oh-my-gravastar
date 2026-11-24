/**
 * Unit tests for `src/profile-switcher-core.ts` — the pure half of the
 * game/app profile switcher (bead 0hl): doc metadata + compatibility
 * badges, the picker list model, and the active-profile / switch-history
 * localStorage store. Runs under Node's native TS stripping:
 *
 *   node scripts/test-profile-switcher.ts
 *
 * No DOM, no device: compatibility runs against synthetic `DeviceLike`
 * identities (the same VID/PID tables `core/device-model.ts` ports from
 * crates/hid), storage is `memoryProfileStorage()`.
 */

declare const process: { exit(code?: number): never };

import {
  PROFILE_SWITCHER_KEY,
  ProfileSwitcherStore,
  buildProfileList,
  profileCompatOf,
  profileDocMeta,
  unknownCompat,
} from '../src/profile-switcher-core.ts';
import {
  memoryProfileStorage,
  profileStateHash,
  stateOfDoc,
  type ProfileDoc,
  type ProfileHistoryEntry,
} from '../src/profile-history.ts';
import type { DeviceLike } from '../src/core/device-model.ts';

let failures = 0;
function check(name: string, cond: unknown, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** Minimal schema-v1 khub916 doc (same shape buildProfileExport makes). */
function makeDoc(opts: {
  protocol?: string;
  model?: string;
  catalogModel?: string;
  catalogName?: string;
  withState?: boolean;
}): ProfileDoc {
  const state: Record<string, unknown> = {};
  if (opts.withState !== false) {
    state.keymap = { '0': ['0x00000004'] };
    state.profile = { bytes: 32, light_mode: 1, sleep_seconds: 60, hex: '00'.repeat(32) };
    state.device_info = {
      uuid: '0xTEST',
      catalog_model: opts.catalogModel ?? '916_K1PRO',
      catalog_name: opts.catalogName ?? 'Mercury K1 PRO',
    };
  }
  return {
    schema: 1,
    exported_at: '2026-01-01T00:00:00.000Z',
    devices: [
      {
        protocol: opts.protocol ?? 'khub916',
        vid: 0x258a,
        pid: 0x010c,
        model: opts.model ?? 'Mercury K1 PRO',
        profiles:
          opts.withState === false ? [] : [{ name: 'current', state }],
      },
    ],
  };
}

function entry(id: string, name: string, doc: ProfileDoc): ProfileHistoryEntry {
  const state = stateOfDoc(doc);
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    name,
    hash: profileStateHash(state),
    doc,
  };
}

/** khub916 wired K1 Pro — VID/PID from device-model.ts KHUB916_WIRED. */
const K1PRO: DeviceLike = {
  vendorId: 0x258a,
  productId: 0x010c,
  productName: 'Gaming Keyboard',
  catalogModel: '916_K1PRO',
  catalogName: 'Mercury K1 PRO',
};

/** A different khub916 model. */
const OTHER_KB: DeviceLike = {
  vendorId: 0x258a,
  productId: 0x019d,
  productName: 'Other Keyboard',
  catalogModel: '916_OTHER',
  catalogName: 'GravaStar Nova',
};

// ── profileDocMeta ────────────────────────────────────────────────────

section('profileDocMeta');
{
  const meta = profileDocMeta(makeDoc({}));
  check('protocol', meta?.protocol === 'khub916');
  check('model', meta?.model === 'Mercury K1 PRO');
  check('catalogModel', meta?.catalogModel === '916_K1PRO');
  check('hasState', meta?.hasState === true);

  const noState = profileDocMeta(makeDoc({ withState: false }));
  check('no state → hasState false', noState?.hasState === false);

  const foreign = profileDocMeta(makeDoc({ protocol: 'he-v2' }));
  check('foreign protocol kept', foreign?.protocol === 'he-v2');

  check('non-doc → null', profileDocMeta({ hello: 1 }) === null);
  check('null → null', profileDocMeta(null) === null);
  check("model 'unknown' → null", profileDocMeta(makeDoc({ model: 'unknown' }))?.model === null);
}

// ── profileCompatOf ───────────────────────────────────────────────────

section('profileCompatOf');
{
  const ok = profileCompatOf(K1PRO, makeDoc({}));
  check('same model → ok', ok.status === 'ok', JSON.stringify(ok));
  check('no errors/warnings', ok.errors.length === 0 && ok.warnings.length === 0);

  // Same keyboard, doc carries only catalogModel (no model/catalogName match needed).
  const warn = profileCompatOf(OTHER_KB, makeDoc({}));
  check('different model → warning', warn.status === 'warning', JSON.stringify(warn));
  check('warning has reasons', warn.warnings.length > 0);

  const proto = profileCompatOf(K1PRO, makeDoc({ protocol: 'he-v2' }));
  check('protocol mismatch → error', proto.status === 'error', JSON.stringify(proto));
  check('error mentions protocol', proto.errors.some((r) => r.includes('protocol')));

  const noState = profileCompatOf(K1PRO, makeDoc({ withState: false }));
  check('no state → error', noState.status === 'error');

  const junk = profileCompatOf(K1PRO, { nope: true });
  check('unrecognised doc → error', junk.status === 'error');
}

// ── buildProfileList ──────────────────────────────────────────────────

section('buildProfileList');
{
  const entries = [
    entry('a', 'Gaming', makeDoc({})),
    entry('b', 'Work', makeDoc({ model: 'GravaStar Nova', catalogModel: '916_OTHER' })),
    entry('c', 'Foreign', makeDoc({ protocol: 'he-v2' })),
  ];
  const items = buildProfileList(entries, K1PRO);
  check('three items', items.length === 3);
  check('order preserved', items.map((i) => i.id).join(',') === 'a,b,c');
  check('name', items[0]?.name === 'Gaming');
  check('model', items[0]?.model === 'Mercury K1 PRO');
  check('sections counted', items[0]?.sections === 2, String(items[0]?.sections));
  check('a ok', items[0]?.compat.status === 'ok');
  check('b warning', items[1]?.compat.status === 'warning');
  check('c error', items[2]?.compat.status === 'error');

  const offline = buildProfileList(entries, null);
  check('offline → unknown compat', offline.every((i) => i.compat.status === 'unknown'));
  check('unknownCompat helper', unknownCompat().status === 'unknown');

  check('empty list', buildProfileList([], K1PRO).length === 0);
}

// ── ProfileSwitcherStore ──────────────────────────────────────────────

section('ProfileSwitcherStore');
{
  const storage = memoryProfileStorage();
  const s = new ProfileSwitcherStore(storage);

  check('starts empty', s.activeId() === null && s.switches().length === 0);

  s.setActive('entry-1');
  check('activeId set', s.activeId() === 'entry-1');
  s.setActive('entry-1'); // idempotent — no throw, still set
  check('idempotent set', s.activeId() === 'entry-1');

  for (let i = 0; i < 60; i++) {
    s.recordSwitch({
      ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      profileId: `p${i}`,
      name: `prof ${i}`,
      outcome: i % 3 === 0 ? 'failed' : i % 3 === 1 ? 'applied' : 'cancelled',
    });
  }
  check('switch log bounded', s.switches().length === 50, String(s.switches().length));
  check('newest first', s.switches()[0]?.profileId === 'p59');

  // Persistence: a second instance over the same storage sees the state.
  const s2 = new ProfileSwitcherStore(storage);
  check('persisted activeId', s2.activeId() === 'entry-1');
  check('persisted switches', s2.switches().length === 50);
  check('storage key', storage.getItem(PROFILE_SWITCHER_KEY) !== null);

  s2.setActive(null);
  check('clear active', s2.activeId() === null);

  s2.clear();
  check('clear wipes log', s2.switches().length === 0);
}

section('ProfileSwitcherStore malformed storage');
{
  const storage = memoryProfileStorage();
  storage.setItem(PROFILE_SWITCHER_KEY, '{not json');
  const s = new ProfileSwitcherStore(storage);
  check('bad json → empty', s.activeId() === null && s.switches().length === 0);

  storage.setItem(
    PROFILE_SWITCHER_KEY,
    JSON.stringify({ activeId: 42, switches: 'nope' }),
  );
  const s2 = new ProfileSwitcherStore(storage);
  check('wrong shape → empty', s2.activeId() === null && s2.switches().length === 0);

  storage.setItem(
    PROFILE_SWITCHER_KEY,
    JSON.stringify({
      activeId: 'x',
      switches: [
        { ts: 't', profileId: 'p', name: 'n', outcome: 'applied' },
        { bogus: true },
        'junk',
      ],
    }),
  );
  const s3 = new ProfileSwitcherStore(storage);
  check('filters bad records', s3.switches().length === 1 && s3.activeId() === 'x');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
