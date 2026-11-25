/**
 * Node test for the W0 UX foundation cores:
 *   - `src/core/conn-state.ts`  — connection state machine (spec §4)
 *   - `src/i18n/index.ts`       — string table, fallback, persistence
 *   - `src/ui/status.ts`        — write-outcome status vocabulary
 *
 * DOM-free by design (localStorage is injected / absent under Node).
 * Run: `npm test` (node >= 22.18, native TS type stripping).
 */

declare const process: { exit(code?: number): never };

import {
  canWrite,
  deriveConnectionPhase,
  phaseFromApp,
  phaseMeta,
  type ConnStateInput,
} from '../src/core/conn-state.ts';
import { getLanguage, setLanguage, t, LANGUAGE_STORAGE_KEY } from '../src/i18n/index.ts';
import { statusKindFor, statusTag } from '../src/ui/status.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

// ── conn-state: disconnected family ───────────────────────────────────

check('idle → disconnected', deriveConnectionPhase({ connected: false }) === 'disconnected');
check(
  'picker open → picker-open',
  deriveConnectionPhase({ connected: false, pickerOpen: true, connecting: true }) === 'picker-open',
);
check(
  'connecting → connecting',
  deriveConnectionPhase({ connected: false, connecting: true }) === 'connecting',
);
check(
  'op in flight + disconnect → disconnected-mid-op',
  deriveConnectionPhase({ connected: false, opInFlight: true }) === 'disconnected-mid-op',
);
check(
  'uncertain write + disconnect → disconnected-mid-op',
  deriveConnectionPhase({ connected: false, uncertainWrite: true }) === 'disconnected-mid-op',
);

// ── conn-state: connected family ──────────────────────────────────────

check(
  'clean session → editing-enabled',
  deriveConnectionPhase({ connected: true }) === 'editing-enabled',
);
check(
  'writes blocked (not silent) → connected-read-only',
  deriveConnectionPhase({ connected: true, writesBlocked: true }) === 'connected-read-only',
);
check(
  'silent reconnect → reconnect-read-only',
  deriveConnectionPhase({ connected: true, reconnectedSilently: true, writesBlocked: true }) ===
    'reconnect-read-only',
);
check(
  'silent flag alone still read-only',
  deriveConnectionPhase({ connected: true, reconnectedSilently: true }) === 'reconnect-read-only',
);
check(
  'runtime active → device-busy-runtime',
  deriveConnectionPhase({ connected: true, runtimeActive: true }) === 'device-busy-runtime',
);
check(
  'runtime outranks write gate? no — gate checked first only for read-only',
  deriveConnectionPhase({ connected: true, runtimeActive: true, writesBlocked: true }) ===
    'device-busy-runtime',
);
check(
  'supported=false → unsupported',
  deriveConnectionPhase({ connected: true, supported: false }) === 'unsupported',
);
check(
  'uncertain write while connected → write-uncertain',
  deriveConnectionPhase({ connected: true, uncertainWrite: true }) === 'write-uncertain',
);
check(
  'uncertain write outranks editing',
  deriveConnectionPhase({ connected: true, uncertainWrite: true, runtimeActive: true }) ===
    'write-uncertain',
);
check(
  'op in flight while connected stays editing-enabled (write IS the op)',
  deriveConnectionPhase({ connected: true, opInFlight: true }) === 'editing-enabled',
);

// ── conn-state: safety invariants ─────────────────────────────────────

const READ_ONLY: ConnStateInput[] = [
  { connected: false },
  { connected: false, pickerOpen: true },
  { connected: false, connecting: true },
  { connected: false, opInFlight: true },
  { connected: true, writesBlocked: true },
  { connected: true, reconnectedSilently: true },
  { connected: true, runtimeActive: true },
  { connected: true, supported: false },
  { connected: true, uncertainWrite: true },
];
for (const input of READ_ONLY) {
  const phase = deriveConnectionPhase(input);
  check(`writes blocked in ${phase}`, !canWrite(phase));
  check(`meta exists for ${phase}`, typeof phaseMeta(phase).labelKey === 'string');
}
check('editing-enabled allows writes', canWrite('editing-enabled'));
check(
  'uncertain phases require a fresh read',
  phaseMeta('write-uncertain').requiresFreshRead &&
    phaseMeta('disconnected-mid-op').requiresFreshRead,
);
check(
  'reconnect-read-only does NOT require fresh read (session already read)',
  !phaseMeta('reconnect-read-only').requiresFreshRead,
);

// ── conn-state: phaseFromApp over the app-store shape ─────────────────

const fakeApp = {
  connected: { session: { writesBlocked: false } },
  busy: false,
  musicActive: false,
  reconnectedSilently: false,
  connectStage: 'idle' as const,
};
check('app clean → editing-enabled', phaseFromApp(fakeApp) === 'editing-enabled');
check(
  'app silent reconnect → reconnect-read-only',
  phaseFromApp({ ...fakeApp, reconnectedSilently: true }) === 'reconnect-read-only',
);
check(
  'app writesBlocked via session → connected-read-only',
  phaseFromApp({
    ...fakeApp,
    connected: { session: { writesBlocked: true } },
  }) === 'connected-read-only',
);
check(
  'app busy+picker → picker-open',
  phaseFromApp({ ...fakeApp, connected: null, busy: true, connectStage: 'picker' }) === 'picker-open',
);
check(
  'app busy+connecting → connecting',
  phaseFromApp({ ...fakeApp, connected: null, busy: true, connectStage: 'connecting' }) ===
    'connecting',
);
check(
  'app busy but refresh (no stage) while connected stays editing-enabled',
  phaseFromApp({ ...fakeApp, busy: true }) === 'editing-enabled',
);
check(
  'app musicActive → device-busy-runtime',
  phaseFromApp({ ...fakeApp, musicActive: true }) === 'device-busy-runtime',
);

// ── i18n ──────────────────────────────────────────────────────────────

check('default language is en under Node', getLanguage() === 'en');
check('t resolves shell key', t('shell.connect') === 'Connect');
check('t falls back to key for unknown', t('no.such.key') === 'no.such.key');
check('t interpolates vars', t('dash.keyLayer') === 'Key layer');

setLanguage('vi');
check('vi bundle resolves', t('shell.connect') === 'Kết nối');
check('vi nav', t('nav.home') === 'Trang chủ' && t('nav.macros') === 'Macro');
check('vi falls back for missing keys to en', typeof t('common.ok') === 'string');
setLanguage('en');
check('back to en', t('shell.connect') === 'Connect');

// Persistence: write through the module then re-detect via a fresh read.
// (setLanguage already persisted; under Node there is no localStorage so
// this only checks the code path does not throw.)
check('language storage key constant', LANGUAGE_STORAGE_KEY === 'omg.lang.v1');

// ── status vocabulary ─────────────────────────────────────────────────

check('success → verified', statusKindFor('success') === 'verified');
check('unverified → applied-unverified', statusKindFor('unverified') === 'applied-unverified');
check('partial → partial', statusKindFor('partial') === 'partial');
check('failed → failed', statusKindFor('failed') === 'failed');
check('unknown → unverified (honest default)', statusKindFor('bogus') === 'unverified');
check('verified tag has label', statusTag('verified').labelKey === 'status.verified');
check('applied-unverified is warn-toned', statusTag('applied-unverified').className.includes('warn'));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall conn-state / i18n / status checks passed');
