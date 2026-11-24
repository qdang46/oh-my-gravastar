/**
 * Unit tests for `src/behavior-core.ts` — the Configure-key behavior
 * model behind the Keys page "Configure key" panel (bead vzx):
 * capability-gated catalog, Easy↔Advanced draft mapping, validation and
 * confirm-dialog summaries. Runs under Node's native TS stripping:
 *
 *   node scripts/test-behavior.ts
 *
 * No DOM, no device: capability maps are built literally and drafts are
 * plain objects, matching the page's usage in behavior-editor.ts.
 */

declare const process: { exit(code?: number): never };

import {
  BEHAVIOR_LABELS,
  MT_TIME_MAX_MS,
  MT_TIME_MAX_UNITS,
  SOCD_DIRECTION_LABELS,
  behaviorCatalog,
  behaviorValueLabel,
  currentBehaviorSummary,
  describeAdvDraft,
  hasForbiddenTag,
  mtMsFromUnits,
  mtUnitsFromMs,
  parseU32Input,
  validateAdvDraft,
  type AdvDraft,
} from '../src/behavior-core.ts';
import type { Capability } from '../src/core/capabilities.ts';

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

const cap = (state: Capability['state'], reason?: string): Capability => ({
  state,
  reason,
  verified: 'code',
});

section('catalog — khub916 with unverified adv_keys (today\'s K1 Pro)');
{
  const cat = behaviorCatalog('khub916', cap('unverified', 'cmd-18 history persistence unconfirmed on K1 Pro'));
  const byId = new Map(cat.map((o) => [o.id, o]));
  check('plain available + staged', byId.get('plain')?.available === true && byId.get('plain')?.write === 'staged');
  for (const id of ['mt', 'socd', 'tgl'] as const) {
    const o = byId.get(id);
    check(`${id} available despite unverified`, o?.available === true);
    check(`${id} writes immediately`, o?.write === 'immediate');
    check(`${id} carries the caveat`, (o?.caveat ?? '').includes('unconfirmed'));
  }
  check('unavailable section present', cat.some((o) => o.group === 'unavailable'));
  const tapDance = byId.get('tap-dance');
  check('tap dance unavailable', tapDance?.available === false && tapDance.write === 'none');
  check('tap dance has reason', (tapDance?.reason ?? '').length > 10);
  const combo = byId.get('combo');
  check('combo reason cites chord-output', (combo?.reason ?? '').includes('chord'));
  const macro = byId.get('macro-behavior');
  check('macro points at Macro page', (macro?.reason ?? '').includes('Macro page'));
}

section('catalog — khub916 adv_keys supported vs unsupported');
{
  const ok = behaviorCatalog('khub916', cap('supported'));
  check('supported → mt available, no caveat', ok.find((o) => o.id === 'mt')?.available === true && ok.find((o) => o.id === 'mt')?.caveat === undefined);
  const bad = behaviorCatalog('khub916', cap('unsupported-hardware', 'mechanical switch'));
  check('unsupported-hardware → mt unavailable', bad.find((o) => o.id === 'mt')?.available === false);
  check('reason surfaced', (bad.find((o) => o.id === 'mt')?.reason ?? '').includes('mechanical'));
  const none = behaviorCatalog('khub916', undefined);
  check('missing cap → adv unavailable', none.find((o) => o.id === 'socd')?.available === false);
}

section('catalog — other protocols');
{
  const he = behaviorCatalog('he-v2', cap('supported'));
  check('HE adv gated off in this UI', he.find((o) => o.id === 'mt')?.available === false);
  check('HE reason mentions hk/CLI', (he.find((o) => o.id === 'mt')?.reason ?? '').includes('omg kb hk'));
  check('HE layer-tap = unknown', (he.find((o) => o.id === 'layer-tap')?.reason ?? '').includes('unknown'));
  const mouse = behaviorCatalog('compx', cap('unsupported-hardware'));
  check('mouse mt unavailable', mouse.find((o) => o.id === 'mt')?.available === false);
  check('mouse reason cites static records', (mouse.find((o) => o.id === 'mt')?.reason ?? '').includes('static'));
  const sp = behaviorCatalog('sparkplayjoy', cap('unsupported-firmware'));
  check('sparkplayjoy read-only reason', (sp.find((o) => o.id === 'tgl')?.reason ?? '').includes('read-only'));
  const unk = behaviorCatalog('unknown', undefined);
  check('unknown protocol → everything gated', unk.find((o) => o.id === 'plain')?.available === true && unk.find((o) => o.id === 'mt')?.available === false);
}

section('mt timing: ms ↔ 10 ms units');
check('200 ms → 20 units', mtUnitsFromMs(200) === 20);
check('205 ms rounds → 21', mtUnitsFromMs(205) === 21);
check('0 ms → 0', mtUnitsFromMs(0) === 0);
check('1000 ms → 100 (max)', mtUnitsFromMs(1000) === MT_TIME_MAX_UNITS);
check('1001 ms → null', mtUnitsFromMs(1001) === null);
check('negative → null', mtUnitsFromMs(-5) === null);
check('NaN → null', mtUnitsFromMs(Number.NaN) === null);
check('units→ms', mtMsFromUnits(20) === 200 && mtMsFromUnits(0) === 0);
check('max ms constant', MT_TIME_MAX_MS === 1000);

section('parseU32Input');
check('hex', parseU32Input('0x00000004') === 4);
check('hex uppercase 0X accepted', parseU32Input('0X1F') === 31); // input is lowercased first
check('dec', parseU32Input('131072') === 131072);
check('none → 0', parseU32Input('none') === 0);
check('empty → 0', parseU32Input('  ') === 0);
check('bad hex → null', parseU32Input('0xZZ') === null);
check('negative → null', parseU32Input('-1') === null);
check('too big → null', parseU32Input('0x1FFFFFFFF') === null);
check('letters → null', parseU32Input('abc') === null);

section('hasForbiddenTag');
check('plain key ok', !hasForbiddenTag(0x00000004));
check('macro tag blocked', hasForbiddenTag(0x03000001));
check('mt tag blocked', hasForbiddenTag(0x21000000));
check('socd tag blocked', hasForbiddenTag(0x20000000));
check('tgl tag blocked', hasForbiddenTag(0x22000000));
check('fn layer ok (0x0D not forbidden)', !hasForbiddenTag(0x0d000000));

section('validateAdvDraft');
{
  const goodMt: AdvDraft = { kind: 'mt', tap: 4, hold: 131072, timeUnits: 20 };
  check('good mt', validateAdvDraft(goodMt) === null);
  check('mt bad time', validateAdvDraft({ ...goodMt, timeUnits: 101 }) !== null);
  check('mt negative time', validateAdvDraft({ ...goodMt, timeUnits: -1 }) !== null);
  check('mt forbidden tap', validateAdvDraft({ ...goodMt, tap: 0x21000000 }) !== null);
  check('mt forbidden hold', validateAdvDraft({ ...goodMt, hold: 0x03000001 }) !== null);
  const goodSocd: AdvDraft = { kind: 'socd', keyA: 4, keyB: 5, direction: 0 };
  check('good socd', validateAdvDraft(goodSocd) === null);
  check('socd same key', validateAdvDraft({ ...goodSocd, keyB: 4 }) !== null);
  check('socd bad dir', validateAdvDraft({ ...goodSocd, direction: 4 }) !== null);
  check('socd oob', validateAdvDraft({ ...goodSocd, keyB: 128 }) !== null);
  const goodTgl: AdvDraft = { kind: 'tgl', key: 4, target: 5 };
  check('good tgl', validateAdvDraft(goodTgl) === null);
  check('tgl oob target', validateAdvDraft({ ...goodTgl, target: 200 }) !== null);
  check('tgl oob key', validateAdvDraft({ ...goodTgl, key: -1 }) !== null);
}

section('describeAdvDraft');
{
  const keyLabel = (i: number) => `key ${i}`;
  const vl = (v: number) => (v === 4 ? 'A' : v === 131072 ? 'L_shift' : '');
  const mt = describeAdvDraft({ kind: 'mt', tap: 4, hold: 131072, timeUnits: 20 }, 10, keyLabel, vl);
  check('mt summary', mt.includes('MT') && mt.includes('key 10') && mt.includes('200 ms'), mt);
  const socd = describeAdvDraft({ kind: 'socd', keyA: 1, keyB: 2, direction: 3 }, 1, keyLabel, vl);
  check('socd summary', socd.includes('SOCD') && socd.includes('All cancel'), socd);
  const tgl = describeAdvDraft({ kind: 'tgl', key: 1, target: 2 }, 1, keyLabel, vl);
  check('tgl summary', tgl.includes('TGL') && tgl.includes('key 2'), tgl);
}

section('currentBehaviorSummary');
{
  check('plain → null', currentBehaviorSummary(0x00000004) === null);
  // MT binding: tag 0x21, slot in bits16..23, time in low16.
  const mtBind = 0x21050000 | 20;
  check('mt binding summary', (currentBehaviorSummary(mtBind) ?? '').includes('MT'));
  const socdBind = 0x20030000 | 1;
  check('socd binding summary', (currentBehaviorSummary(socdBind) ?? '').includes('SOCD'));
  const tglBind = 0x22070000;
  check('tgl binding summary', (currentBehaviorSummary(tglBind) ?? '').includes('TGL'));
}

section('labels / misc');
check('direction labels = 4', SOCD_DIRECTION_LABELS.length === 4);
check('every catalog id labelled', Object.keys(BEHAVIOR_LABELS).length === 17);
check('behaviorValueLabel plain', behaviorValueLabel(0x00000004).length > 0);
check('behaviorValueLabel zero → empty', behaviorValueLabel(0) === '');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
