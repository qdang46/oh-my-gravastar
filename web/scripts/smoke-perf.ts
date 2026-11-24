/**
 * Node smoke test for `src/perf-core.ts` — the DOM-free helpers behind
 * the Performance Studio page (bead `xp0`): actuation/RT draft
 * validation (mirroring `omg kb perf set` range rules), DKS/MPT
 * higher-key draft validation, keyboard geometry layout and live-travel
 * helpers. Run:
 *   npm run smoke   (node >= 22.18, native TS type stripping)
 *
 * Everything here is synthetic — no HE hardware was available; all
 * write paths remain code-verified, hardware-unverified.
 */

declare const process: { exit(code?: number): never };

import {
  DEADZONE_MAX_MM,
  HK_DEADBAND_MAX_MM,
  KEY_UNIT_PX,
  UFO_SWITCH_ID,
  applyPerfDraft,
  buildHkParams,
  draftFromPerf,
  fmtMm,
  heKeyLabel,
  hkConfigSummary,
  hkDraftError,
  keySizeWH,
  keycodeError,
  layoutKeyGrid,
  liveRowSummary,
  maxTravelFor,
  parseKcInput,
  parseMmInput,
  perfChanges,
  travelFill,
  validatePerfDraft,
  type PerfDraft,
} from '../src/perf-core.ts';
import { MODE_FIXED, MODE_RAPID, type HigherKeyConfig, type KeyPerf, type KeySlot } from '../src/proto/he.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function section(name: string): void {
  console.log(`\n— ${name}`);
}

/** Synthetic `04 01` reply parse result: fixed mode, sane defaults. */
function basePerf(over: Partial<KeyPerf> = {}): KeyPerf {
  return {
    mode: MODE_FIXED,
    normalPress: 2.0,
    normalRelease: 0,
    rtFirstTouch: 1.0,
    rtPress: 0.5,
    rtRelease: 0.5,
    pressDeadzone: 0.1,
    releaseDeadzone: 0.1,
    axis: 3,
    calibrate: 0,
    axisV2Id: 1234,
    axisRangeMax: 3400,
    axisCoefficient: 100,
    ...over,
  };
}

function draftOf(p: KeyPerf, over: Partial<PerfDraft> = {}): PerfDraft {
  return { ...draftFromPerf(p), ...over };
}

// ── Limits & formatting ────────────────────────────────────────────────

section('limits & formatting');
{
  check('UFO switch → 3.5 mm', maxTravelFor(UFO_SWITCH_ID) === 3.5);
  check('other switch → 3.4 mm', maxTravelFor(1234) === 3.4);
  check('deadzone max is 1 mm', DEADZONE_MAX_MM === 1.0);
  check('HK deadband bound is 3.5 mm', HK_DEADBAND_MAX_MM === 3.5);

  check('fmtMm integer', fmtMm(2) === '2 mm');
  check('fmtMm keeps sub-mm', fmtMm(0.05) === '0.05 mm');
  check('fmtMm trims', fmtMm(1.5) === '1.5 mm');

  check('parseMmInput decimal', parseMmInput(' 1.25 ') === 1.25);
  check('parseMmInput rejects junk', parseMmInput('abc') === null);
  check('parseMmInput rejects hex', parseMmInput('0x10') === null);
  check('parseMmInput rejects empty', parseMmInput('') === null);
  check('parseMmInput rejects NaN', parseMmInput('NaN') === null);
}

// ── Keycode parsing ────────────────────────────────────────────────────

section('keycode parsing');
{
  check('decimal kc', parseKcInput('4') === 4);
  check('hex kc', parseKcInput('0xF101') === 0xf101);
  check('hex lowercase', parseKcInput('0xf101') === 0xf101);
  check('kc rejects letters', parseKcInput('A') === null);
  check('kc rejects negative', parseKcInput('-1') === null);
  check('kc rejects >0xFFFF', parseKcInput('0x10000') === null);
  check('kc rejects float', parseKcInput('4.5') === null);

  check('keycodeError flags 0xF200', keycodeError(0xf200) !== null);
  check('keycodeError flags 0xF203', keycodeError(0xf203) !== null);
  check('keycodeError allows 0x04', keycodeError(0x04) === null);
  check('keycodeError flags range', keycodeError(0x1_0000) !== null);
}

// ── Key labels ─────────────────────────────────────────────────────────

section('key labels');
{
  check('letter key', heKeyLabel(0x04) === 'A');
  check('digit key', heKeyLabel(0x1e) === '1');
  check('F-key', heKeyLabel(0x3a) === 'F1');
  check('named key', heKeyLabel(0x28) === 'Enter');
  check('unnamed → 0x hex', heKeyLabel(0x0700) === '0x700', heKeyLabel(0x0700));
  check('zero → placeholder', heKeyLabel(0) === '·');
}

// ── Geometry ───────────────────────────────────────────────────────────

section('geometry');
{
  check('size 1 → 1u', eq(keySizeWH(1), { w: 1, h: 1, isoEnter: false }));
  check('size 2 → 1.25u', keySizeWH(2).w === 1.25);
  check('size 9 → 6.25u', keySizeWH(9).w === 6.25);
  check('size 10 → 2u tall', keySizeWH(10).h === 2);
  check('size 11 → ISO enter', keySizeWH(11).isoEnter === true && keySizeWH(11).h === 2);
  check('unknown size → 1u', keySizeWH(99).w === 1);

  const slots: KeySlot[] = [
    { row: 1, col: 0, x: 0, y: 4, size: 1 },
    { row: 1, col: 1, x: 1.25, y: 5.5, size: 3 },
    { row: 2, col: 0, x: 0, y: 9, size: 1 },
  ];
  const grid = layoutKeyGrid(slots);
  check('grid normalises top y to 0', grid.cells[0]?.y === 0);
  check('grid cell px', grid.cells[0]?.w === KEY_UNIT_PX && grid.cells[0]?.x === 0);
  check('grid cell 2 offset', Math.abs((grid.cells[1]?.x ?? 0) - 1.25 * KEY_UNIT_PX) < 1e-6);
  // Right edge: cell 1 spans x 1.25u..2.75u → 2.75 * 44 = 121 px.
  // Bottom edge: lowest cell ends at y 6u (9 - top 4 + 1u) → 264 px.
  check('grid bounds', grid.width === 121 && grid.height === 264,
    `${grid.width}x${grid.height}`);
  check('empty slots → empty grid', eq(layoutKeyGrid([]), { width: 0, height: 0, cells: [] }));
}

// ── Perf draft validation ──────────────────────────────────────────────

section('perf draft validation');
{
  const p = basePerf();
  const good = draftOf(p);
  check('unmodified draft valid', validatePerfDraft(p, good) === null);

  check('actuation too deep', validatePerfDraft(p, draftOf(p, { normalPress: 3.5 })) !== null);
  check('actuation zero', validatePerfDraft(p, draftOf(p, { normalPress: 0 })) !== null);
  check('UFO allows 3.5', validatePerfDraft(basePerf({ axisV2Id: UFO_SWITCH_ID }),
    draftOf(basePerf({ axisV2Id: UFO_SWITCH_ID }), { normalPress: 3.5 })) === null);
  check('rt press too deep', validatePerfDraft(p, draftOf(p, { rtPress: 9 })) !== null);
  check('rt mode actuation uses rtFirstTouch',
    validatePerfDraft(basePerf({ mode: MODE_RAPID }), draftOf(basePerf({ mode: MODE_RAPID }), { rtFirstTouch: 0 })) !== null);
  check('deadzone > 1 mm', validatePerfDraft(p, draftOf(p, { pressDeadzone: 1.5 })) !== null);
  check('deadzone negative', validatePerfDraft(p, draftOf(p, { releaseDeadzone: -0.1 })) !== null);
  check('deadzone 1 mm ok', validatePerfDraft(p, draftOf(p, { pressDeadzone: 1.0 })) === null);
  check('NaN rejected', validatePerfDraft(p, draftOf(p, { rtPress: NaN })) !== null);
  check('bad mode rejected', validatePerfDraft(p, draftOf(p, { mode: 7 })) !== null);
  check('release point bounded', validatePerfDraft(p, draftOf(p, { normalRelease: 9 })) !== null);
  check('release point 0 ok', validatePerfDraft(p, draftOf(p, { normalRelease: 0 })) === null);
}

// ── Perf apply / diff ──────────────────────────────────────────────────

section('perf apply & diff');
{
  const p = basePerf();
  const next = applyPerfDraft(p, draftOf(p, { normalPress: 1.5, pressDeadzone: 0.2 }));
  check('echo fields preserved', next.axisV2Id === p.axisV2Id && next.axis === p.axis &&
    next.axisRangeMax === p.axisRangeMax && next.axisCoefficient === p.axisCoefficient);
  check('edited field applied', next.normalPress === 1.5 && next.pressDeadzone === 0.2);
  check('untouched field kept', next.rtPress === p.rtPress);

  const changes = perfChanges(p, next);
  check('diff has 2 lines', changes.length === 2, JSON.stringify(changes));
  check('diff names fields', changes.some((l) => l.includes('actuation point')) &&
    changes.some((l) => l.includes('press deadzone')));
  check('no change → single line', eq(perfChanges(p, p), ['no effective change']));

  const rt = applyPerfDraft(basePerf({ mode: MODE_RAPID }),
    draftOf(basePerf({ mode: MODE_RAPID }), { mode: MODE_FIXED }));
  check('mode change detected', perfChanges(basePerf({ mode: MODE_RAPID }), rt)[0]?.includes('rapid trigger'));
}

// ── HigherKey (DKS/MPT) ────────────────────────────────────────────────

section('higher-key drafts');
{
  const dksKcs = [0x04, 0x05, 0x06, 0x07];
  const dksNums = [10, 20, 30, 40, 0.5, 0.5];
  check('valid dks', hkDraftError('dks', dksKcs, dksNums) === null);
  check('dks needs 4 kcs', hkDraftError('dks', [1, 2, 3], dksNums) !== null);
  check('dks needs 6 nums', hkDraftError('dks', dksKcs, [1, 2]) !== null);
  check('dks trp >255', hkDraftError('dks', dksKcs, [300, 20, 30, 40, 0.5, 0.5]) !== null);
  check('dks trp non-integer', hkDraftError('dks', dksKcs, [1.5, 20, 30, 40, 0.5, 0.5]) !== null);
  check('dks db > bound', hkDraftError('dks', dksKcs, [10, 20, 30, 40, 9, 0.5]) !== null);
  check('dks blacklisted kc', hkDraftError('dks', [0xf200, 5, 6, 7], dksNums) !== null);

  const mptKcs = [0x04, 0x05, 0x06];
  const mptNums = [0.2, 0.3, 0.4];
  check('valid mpt', hkDraftError('mpt', mptKcs, mptNums) === null);
  check('mpt needs 3 kcs', hkDraftError('mpt', [1, 2], mptNums) !== null);
  check('mpt needs 3 dbs', hkDraftError('mpt', mptKcs, [0.2]) !== null);
  check('none always valid', hkDraftError('none', [], []) === null);

  const p = buildHkParams('dks', dksKcs, dksNums);
  check('dks params shape', p.mode === 'dks' && p.params.kcs.length === 4 &&
    p.params.trps[0] === 10 && p.params.dbs[0] === 0.5);
  const mp = buildHkParams('mpt', mptKcs, mptNums);
  check('mpt params shape', mp.mode === 'mpt' && mp.params.kcs.length === 3 &&
    mp.params.dbs.length === 3);
}

// ── HK config summary ──────────────────────────────────────────────────

section('hk config summary');
{
  const none: HigherKeyConfig = { mode: 'none', row: 1, col: 2 };
  check('none summary', hkConfigSummary(none) === 'none — normal key');
  const dks: HigherKeyConfig = {
    mode: 'dks', row: 1, col: 2,
    params: { kcs: [4, 5, 6, 7], trps: [1, 2, 3, 4], dbs: [0.5, 0.6] },
  };
  const s = hkConfigSummary(dks);
  check('dks summary mentions mode', s.startsWith('DKS'));
  check('dks summary has keycodes', s.includes('0x0004') && s.includes('0x0007'));
  const mt: HigherKeyConfig = { mode: 'mt', row: 0, col: 0, params: { kcs: [4, 5], time: 500 } };
  check('mt summary read-only note', hkConfigSummary(mt).includes('unverified'));
}

// ── Live travel ────────────────────────────────────────────────────────

section('live travel');
{
  check('fill 0 at rest', travelFill(0, 3.4) === 0);
  check('fill half', Math.abs(travelFill(1.7, 3.4) - 0.5) < 1e-9);
  check('fill clamps >1', travelFill(9, 3.4) === 1);
  check('fill clamps <0', travelFill(-1, 3.4) === 0);
  check('fill zero max', travelFill(1, 0) === 0);
  check('fill NaN', travelFill(NaN, 3.4) === 0);

  const summary = liveRowSummary([
    { travelMm: 0.5, actuated: false },
    { travelMm: 2.5, actuated: true },
    { travelMm: 1.0, actuated: false },
  ]);
  check('row summary actuated count', summary.startsWith('1 actuated'), summary);
  check('row summary deepest', summary.includes('2.5 mm'), summary);
}

console.log(failures === 0 ? '\nall perf-core checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
