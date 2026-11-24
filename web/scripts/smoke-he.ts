/**
 * Node smoke test for the HE keyboard "v2" protocol — pure codec
 * (`src/proto/he.ts`, port of `crates/proto-he/src/lib.rs`) plus the
 * `HeSession` transport logic in `src/he.ts` against a mock
 * `HeTransport` (packet layout, echo matching, timeout/retry/poison,
 * read-back verify). Run:
 *   npm run smoke-he   (node >= 22.18, native TS type stripping)
 *
 * Everything here is synthetic — no HE hardware was available; all
 * write paths remain code-verified, hardware-unverified.
 */

declare const process: { exit(code?: number): never };

import {
  CAT,
  HK_MODE,
  HE_PIDS,
  HE_USAGE_PAGE,
  HE_VIDS,
  KEY_COLUMNS,
  LAYOUT_CMD,
  LIGHT_CMD,
  MACRO_CMD,
  MACRO_PAGE_ACTIONS,
  MODE_RAPID,
  PALETTE_SIZE,
  PERF_CMD,
  REPORT_BYTES,
  REPORT_RATES,
  buildReport,
  calibrationReport,
  defaultLayoutReport,
  heDeviceFilters,
  higherKeyWriteReports,
  hkKeyCodes,
  hkModeOf,
  keyCodeWriteReport,
  keyPerfReport,
  keyRowWriteReport,
  keycodeBlacklisted,
  lightingSleepWriteReport,
  lightingWriteReport,
  macroActionDecode,
  macroActionEncode,
  macroDataReport,
  macroModeReport,
  matchesHeDevice,
  paletteWriteReport,
  parseDefaultLayoutReply,
  parseDeviceInfoReply,
  parseHigherKey,
  parseKeyCodes,
  parseKeyPerf,
  parseKeySlots,
  parseLighting,
  parseLightingAreas,
  parseLiveRow,
  parseMacroModeReply,
  parseMacroPage,
  parsePalette,
  parseProtocolVersion,
  parseReportRateList,
  profileSwitchReport,
  rd16,
  reportEchoMatches,
  reportRateWriteReport,
  systemWriteReport,
  type HigherKeyParams,
  type KeyPerf,
  type MacroAction,
} from '../src/proto/he.ts';
import { HeNoAnswerError, HeSession, type HeTransport } from '../src/he.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function section(name: string): void {
  console.log(`\n— ${name}`);
}

/** 64-byte echo-style reply: payload bytes then zero padding. */
function reply(...parts: number[]): Uint8Array {
  return buildReport(parts);
}

// ── Packet layout ──────────────────────────────────────────────────────

section('packet layout');
{
  const pkt = buildReport([CAT.layout, LAYOUT_CMD.keyRowRead, 0, 2]);
  check('report is 64 bytes', pkt.length === REPORT_BYTES);
  check('header bytes', pkt[0] === 3 && pkt[1] === 1 && pkt[2] === 0 && pkt[3] === 2);
  check('zero padding', pkt.slice(4).every((b) => b === 0));
  check('buildReport rejects >64', (() => {
    try {
      buildReport(new Array(65).fill(0));
      return false;
    } catch {
      return true;
    }
  })());

  check('echo match 2 bytes', reportEchoMatches(pkt, reply(3, 1, 9, 9), 2));
  check('echo match rejects wrong cmd', !reportEchoMatches(pkt, reply(3, 2, 0, 2), 2));
  check('echo match deep prefix', reportEchoMatches(reply(3, 3, 1, 2, 5), reply(3, 3, 1, 2, 5, 0, 0), 5));
  check('echo match rejects wrong col', !reportEchoMatches(reply(3, 3, 1, 2, 5), reply(3, 3, 1, 2, 6, 0, 0), 5));

  check('identity: HE v2 matches', matchesHeDevice(0x1ca6, 11272, HE_USAGE_PAGE));
  check('identity: 0x31E3/4896 matches', matchesHeDevice(0x31e3, 4896, HE_USAGE_PAGE));
  check('identity: wrong usage page', !matchesHeDevice(0x1ca6, 11272, 0xffa0));
  check('identity: wrong pid', !matchesHeDevice(0x1ca6, 9999, HE_USAGE_PAGE));
  check('identity: khub916 VID rejected', !matchesHeDevice(0x258a, 0x010c, HE_USAGE_PAGE));

  const filters = heDeviceFilters();
  check('filters = VIDS × PIDS', filters.length === HE_VIDS.length * HE_PIDS.length, String(filters.length));
  check('filters carry usagePage', filters.every((f) => f.usagePage === HE_USAGE_PAGE));
}

// ── Device / global reads ──────────────────────────────────────────────

section('device & global codec');
{
  check('protocol version', parseProtocolVersion(reply(1, 1, 2, 7)) === '2.7');

  // `01 02` reply: board id BE @4..8, fw bytes @8..12, pcb @12..16, ts @29.
  const info = new Uint8Array(64);
  info.set([1, 2], 0);
  info.set([0xde, 0xad, 0xbe, 0xef], 4);
  info.set([1, 2, 3, 4], 8);
  info.set([10, 20, 30, 40], 12);
  for (let i = 0; i < 16; i++) info[29 + i] = '20260102123045'.charCodeAt(i);
  const parsed = parseDeviceInfoReply(info);
  check('board id BE', parsed.boardId === 0xdeadbeef, parsed.boardIdHex);
  check('firmware dotted', parsed.firmware === '1.2.3.4', parsed.firmware);
  check('pcb dashed', parsed.pcb === '10-20-30-40', parsed.pcb);
  check('build time verbatim', parsed.buildTime === '20260102123045', parsed.buildTime);

  const rates = parseReportRateList(reply(2, 5, 0, 3, 0, 1, 4));
  check('report rate list', rates.length === 3 && rates[0] === 0 && rates[2] === 4);
  check('REPORT_RATES labels', REPORT_RATES[0] === '8K' && REPORT_RATES[6] === '125');

  // `02 08 00`: count=2, zones [index, effects, rows, cols].
  const areas = parseLightingAreas(reply(2, 8, 0, 2, 0, 16, 5, 15, 1, 2, 1, 14));
  check('lighting areas count', areas.length === 2);
  check('zone 0 fields', areas[0]?.index === 0 && areas[0]?.count === 16 && areas[0]?.rows === 5 && areas[0]?.cols === 15);
  check('zone 1 fields', areas[1]?.index === 1 && areas[1]?.count === 2);

  check('profile switch packet', (() => {
    const p = profileSwitchReport(2);
    return p[0] === 2 && p[1] === 3 && p[2] === 2 && p[3] === 2 && p.length === 64;
  })());
  check('system write packet', systemWriteReport(1)[3] === 1);
  check('report rate write packet', reportRateWriteReport(4)[3] === 4);
  const ls = lightingSleepWriteReport(30);
  check('lighting sleep u16 LE', ls[0] === 2 && ls[1] === 13 && ls[2] === 0 && ls[3] === 30 && ls[4] === 0);
  check('calibration start', calibrationReport(true)[2] === 0 && calibrationReport(true)[1] === 6);
  check('calibration finish', calibrationReport(false)[2] === 1);
}

// ── Layout & keymap ────────────────────────────────────────────────────

section('layout & keymap codec');
{
  // `03 05` geometry: packed u16 per column at byte 3+2·col.
  const geo = new Uint8Array(64);
  geo.set([3, 5, 0], 0);
  const v0 = (4 << 11) | 1; // y=1.0, x=0, size 1
  const v1 = (10 << 11) | (5 << 4) | 3; // y=2.5, x=1.25, size 3
  geo[3] = v0 & 0xff; geo[4] = v0 >> 8;
  geo[5] = v1 & 0xff; geo[6] = v1 >> 8;
  const slots = parseKeySlots(2, geo);
  check('slot count', slots.length === 2);
  check('slot 0 decode', slots[0]?.x === 0 && slots[0]?.y === 1 && slots[0]?.size === 1 && slots[0]?.col === 0);
  check('slot 1 decode', Math.abs((slots[1]?.x ?? 0) - 1.25) < 1e-9 && slots[1]?.y === 2.5 && slots[1]?.size === 3);

  // `03 01` keycodes: 21 × u16 LE from byte 4.
  const kr = new Uint8Array(64);
  kr.set([3, 1, 0, 2], 0);
  const codes: number[] = [];
  for (let i = 0; i < KEY_COLUMNS; i++) codes.push(i === 3 ? 0xf101 : 0x04 + i);
  codes.forEach((c, i) => {
    kr[4 + 2 * i] = c & 0xff;
    kr[5 + 2 * i] = (c >> 8) & 0xff;
  });
  const parsed = parseKeyCodes(kr);
  check('keyCodes round-trip', parsed.length === KEY_COLUMNS && parsed[3] === 0xf101 && parsed[20] === 0x18);

  const rowWrite = keyRowWriteReport(0, 2, codes);
  check('row write header', rowWrite[0] === 3 && rowWrite[1] === 2 && rowWrite[2] === 0 && rowWrite[3] === 2);
  check('row write len', rowWrite.length === 4 + KEY_COLUMNS * 2);
  check('row write LE', rowWrite[4] === 0x04 && rowWrite[5] === 0 && rowWrite[10] === 0x01 && rowWrite[11] === 0xf1);
  check('row write blacklist', (() => {
    const bad = codes.slice();
    bad[0] = 0xf200;
    try { keyRowWriteReport(0, 2, bad); return false; } catch { return true; }
  })());
  check('keycodeBlacklisted', keycodeBlacklisted(0xf200) && keycodeBlacklisted(0xf203) && !keycodeBlacklisted(0xf101));

  const kc = keyCodeWriteReport(1, 2, 3, 0xf101);
  check('key code write', kc[0] === 3 && kc[1] === 4 && kc[2] === 1 && kc[3] === 2 && kc[4] === 3 && kc[5] === 0x01 && kc[6] === 0xf1);
  check('key code write blacklist', (() => {
    try { keyCodeWriteReport(0, 0, 0, 0xf203); return false; } catch { return true; }
  })());

  const dl = defaultLayoutReport(1, 2, 5);
  check('default layout selector', dl[0] === 3 && dl[1] === 6 && dl[2] === 0x12 && dl[3] === 5);
  const dlr = new Uint8Array(64);
  dlr.set([3, 6, 0x12, 5], 0);
  dlr.set([0x04, 0x00, 0x05, 0x00], 4);
  const dlp = parseDefaultLayoutReply(dlr);
  check('default layout parse', dlp.system === 1 && dlp.func === 2 && dlp.row === 5 && dlp.keyCodes[0] === 4 && dlp.keyCodes[1] === 5);
}

// ── Performance ────────────────────────────────────────────────────────

section('performance codec');
{
  const perf: KeyPerf = {
    mode: MODE_RAPID,
    normalPress: 1.2345,
    normalRelease: 2.0,
    rtFirstTouch: 0.5,
    rtPress: 3.4,
    rtRelease: 1.0,
    pressDeadzone: 0.25,
    releaseDeadzone: 0.1,
    axis: 3,
    calibrate: 1,
    axisV2Id: 13232,
    axisRangeMax: 65535,
    axisCoefficient: 100,
  };
  const pkt = keyPerfReport(1, 2, perf);
  check('perf write header', pkt[0] === CAT.performance && pkt[1] === PERF_CMD.keyWrite && pkt[2] === 1 && pkt[3] === 2 && pkt[4] === MODE_RAPID);
  check('perf write len', pkt.length === 27);
  const back = parseKeyPerf(pkt);
  check('perf round-trip mode', back.mode === MODE_RAPID);
  check('perf round-trip dist', Math.abs(back.normalPress - 1.235) < 1e-6 && back.normalRelease === 2.0, `${back.normalPress}`);
  check('perf round-trip echoes', back.axis === 3 && back.calibrate === 1 && back.axisV2Id === 13232 && back.axisRangeMax === 65535 && back.axisCoefficient === 100);

  // Live row: travel µm @4+2i, status flags @4+2i.
  const travel = new Uint8Array(64);
  const status = new Uint8Array(64);
  travel.set([4, 3, 1, 2], 0);
  status.set([4, 3, 3, 2], 0);
  travel[4] = 0xe8; travel[5] = 0x03; // 1000 µm = 1.0 mm
  status[6] = 1; // col 1 actuated
  const live = parseLiveRow(travel, status);
  check('live row len', live.length === KEY_COLUMNS);
  check('live travel mm', live[0]?.travelMm === 1.0, String(live[0]?.travelMm));
  check('live actuated', live[1]?.actuated === true && live[0]?.actuated === false);
}

// ── Lighting ───────────────────────────────────────────────────────────

section('lighting codec');
{
  const l = { on: true, mode: 12, brightness: 80, speed: 50, direction: 1, colorIndex: 3 };
  const w = lightingWriteReport(1, l);
  check('lighting write header', w[0] === CAT.lighting && w[1] === 2 && w[2] === 1 && w[3] === LIGHT_CMD.whatEffect);
  check('lighting write fields', w[4] === 1 && w[5] === 12 && w[6] === 80 && w[7] === 50 && w[8] === 1 && w[9] === 3);
  const back = parseLighting(w);
  check('lighting round-trip', back.on && back.mode === 12 && back.brightness === 80 && back.speed === 50 && back.direction === 1 && back.colorIndex === 3);

  // Palette wire order B,G,R,H: entry 0 wire B=10 G=20 R=30.
  const pal = new Uint8Array(64);
  pal.set([5, 1, 0, 1], 0);
  pal[4] = 10; pal[5] = 20; pal[6] = 30;
  const colors = parsePalette(pal);
  check('palette size', colors.length === PALETTE_SIZE);
  check('palette BGR decode', colors[0]?.r === 30 && colors[0]?.g === 20 && colors[0]?.b === 10);

  const pw = paletteWriteReport(2, [{ r: 1, g: 2, b: 3 }, ...Array.from({ length: 7 }, () => ({ r: 0, g: 0, b: 0 }))]);
  check('palette write header', pw[0] === 5 && pw[1] === 2 && pw[2] === 2 && pw[3] === 1);
  check('palette write BGR', pw[4] === 3 && pw[5] === 2 && pw[6] === 1 && pw[7] === 0);
  check('palette write len', pw.length === 64);
}

// ── HigherKey ──────────────────────────────────────────────────────────

section('higher-key codec');
{
  const none: HigherKeyParams = { mode: 'none' };
  check('hk none packet', (() => {
    const p = higherKeyWriteReports(2, 5, none)[0];
    return p !== undefined && p[0] === 6 && p[1] === 2 && p[2] === 2 && p[3] === 5 && p[4] === HK_MODE.none;
  })());

  const dks: HigherKeyParams = {
    mode: 'dks',
    params: { kcs: [4, 5, 6, 7], trps: [10, 20, 30, 40], dbs: [1.5, 2.25] },
  };
  const dp = higherKeyWriteReports(1, 3, dks)[0];
  check('hk dks header', dp !== undefined && dp[4] === 1 && dp[5] === 4 && dp[6] === 0);
  check('hk dks trps', dp !== undefined && dp[13] === 10 && dp[14] === 20 && dp[15] === 30 && dp[16] === 40);
  check('hk dks dbs µm', dp !== undefined && rd16(dp, 17) === 1500 && rd16(dp, 19) === 2250);
  const dksBack = dp !== undefined ? parseHigherKey(dp) : null;
  check('hk dks round-trip', dksBack?.mode === 'dks' && JSON.stringify(hkKeyCodes(dks)) === JSON.stringify([4, 5, 6, 7]));

  // SOCD: two cross-linked packets (port of the Rust test vectors).
  const socd: HigherKeyParams = {
    mode: 'socd',
    params: { row2: 3, col2: 7, kcs: [0x1e, 0x1f], delay: 100, direction: 'priorityA' },
  };
  const sp = higherKeyWriteReports(1, 2, socd);
  check('socd two packets', sp.length === 2);
  check('socd packet A', sp[0] !== undefined && sp[0][0] === 6 && sp[0][1] === 2 && sp[0][2] === 1 && sp[0][3] === 2 && sp[0][4] === 6 && sp[0][5] === 3 && sp[0][6] === 7 && sp[0][13] === 1);
  check('socd packet B swapped', sp[1] !== undefined && sp[1][2] === 3 && sp[1][3] === 7 && sp[1][5] === 1 && sp[1][6] === 2 && sp[1][13] === 2);
  const socdBack = sp[0] !== undefined ? parseHigherKey(sp[0]) : null;
  // Packet A carries dirA=1 → parses as priorityA.
  check('socd dir decode', socdBack?.mode === 'socd' && (socdBack.params as { direction: string }).direction === 'priorityA');

  const rs: HigherKeyParams = {
    mode: 'rs',
    params: { row2: 4, col2: 9, kcs: [0x20, 0x21], delay: 55 },
  };
  const rp = higherKeyWriteReports(1, 2, rs);
  check('rs two packets no dir byte', rp.length === 2 && rp[0] !== undefined && rd16(rp[0], 11) === 55 && rp[0][13] === 0);

  check('hk blacklist', (() => {
    try {
      higherKeyWriteReports(0, 0, { mode: 'tgl', params: { kcs: 0xf200, time: 1 } });
      return false;
    } catch {
      return true;
    }
  })());
  check('hk mode map', hkModeOf({ mode: 'mt', params: { kcs: [1, 2], time: 0 } }) === HK_MODE.mt);

  // parseHigherKey on a synthetic read reply.
  const hkr = new Uint8Array(64);
  hkr.set([6, 1, 3, 4, HK_MODE.mt], 0);
  hkr[5] = 0x34; hkr[6] = 0x12; hkr[7] = 0x78; hkr[8] = 0x56; hkr[9] = 0xab; hkr[10] = 0x00;
  const mt = parseHigherKey(hkr);
  check('hk mt decode', mt?.mode === 'mt' && (mt.params as { kcs: number[] }).kcs[0] === 0x1234 && (mt.params as { time: number }).time === 0xab);
  hkr[4] = 42;
  check('hk unknown mode → null', parseHigherKey(hkr) === null);
}

// ── Macro ──────────────────────────────────────────────────────────────

section('macro codec');
{
  const a: MacroAction = { status: true, delay: 0x1234, keyCode: 0x5678 };
  const w = macroActionEncode(a);
  check('macro action word', w === (0x80000000 | (0x1234 << 16) | 0x5678), w.toString(16));
  const dec = macroActionDecode(w);
  check('macro action round-trip', dec.status === true && dec.delay === 0x1234 && dec.keyCode === 0x5678);
  check('macro action rejects delay', (() => {
    try { macroActionEncode({ status: false, delay: 32768, keyCode: 4 }); return false; } catch { return true; }
  })());
  check('macro action rejects kc', (() => {
    try { macroActionEncode({ status: false, delay: 1, keyCode: 0xf203 }); return false; } catch { return true; }
  })());

  const mm = macroModeReport({ macroId: 2, valid: true, actNum: 0x0304, repNum: 0x0506, mode: 1 });
  check('macro mode packet', mm[0] === CAT.macro && mm[1] === MACRO_CMD.modeWrite && mm[2] === 2 && mm[3] === 1 && mm[4] === 0x04 && mm[5] === 0x03 && mm[6] === 0x06 && mm[7] === 0x05 && mm[8] === 1);

  const mpr = new Uint8Array(64);
  mpr.set([7, 1, 2, 1, 0x04, 0x03, 0x06, 0x05, 1], 0);
  const mmp = parseMacroModeReply(mpr);
  check('macro mode parse', mmp.macroId === 2 && mmp.valid && mmp.actNum === 0x0304 && mmp.repNum === 0x0506 && mmp.mode === 1);

  const actions: MacroAction[] = [
    { status: false, delay: 10, keyCode: 0x04 },
    { status: true, delay: 20, keyCode: 0x05 },
  ];
  const md = macroDataReport(1, 0, actions);
  check('macro data header', md[0] === 7 && md[1] === MACRO_CMD.dataWrite && md[2] === 1 && md[3] === 0);
  check('macro data len', md.length === 64); // padded
  check('macro data 15 cap', (() => {
    try {
      macroDataReport(0, 0, Array.from({ length: MACRO_PAGE_ACTIONS + 1 }, () => ({ status: false, delay: 0, keyCode: 4 })));
      return false;
    } catch {
      return true;
    }
  })());

  const page = new Uint8Array(64);
  page.set([7, 3, 5, 1], 0);
  const wa = macroActionEncode({ status: true, delay: 42, keyCode: 0x1e });
  page[4] = wa & 0xff; page[5] = (wa >>> 8) & 0xff; page[6] = (wa >>> 16) & 0xff; page[7] = (wa >>> 24) & 0xff;
  const pg = parseMacroPage(page);
  check('macro page parse', pg.macroId === 5 && pg.offset === 1 && pg.actions.length === MACRO_PAGE_ACTIONS);
  check('macro page action', pg.actions[0]?.status === true && pg.actions[0]?.delay === 42 && pg.actions[0]?.keyCode === 0x1e);
  check('macro page zero tail', pg.actions[1]?.keyCode === 0 && pg.actions[1]?.delay === 0);
}

// ── Session over mock transport ────────────────────────────────────────

/** Scripted transport: queued replies, or scripted failure modes. */
class MockTransport implements HeTransport {
  readonly sent: Uint8Array[] = [];
  /** Total sendReport calls (including ones that throw). */
  sends = 0;
  private queue: Uint8Array[] = [];
  mode: 'ok' | 'reject' | 'hang' = 'ok';

  push(...replies: Uint8Array[]): void {
    this.queue.push(...replies);
  }

  async sendReport(_id: number, data: Uint8Array): Promise<void> {
    this.sends++;
    if (this.mode === 'reject') throw new Error('mock: device gone');
    this.sent.push(new Uint8Array(data));
  }

  async receiveReport(_id: number): Promise<DataView> {
    if (this.mode === 'reject') throw new Error('mock: device gone');
    if (this.mode === 'hang') return new Promise<DataView>(() => {});
    const next = this.queue.shift();
    if (next === undefined) return new Promise<DataView>(() => {});
    return new DataView(next.buffer, next.byteOffset, next.byteLength);
  }
}

const FAST = { timeoutMs: 40 };

section('HeSession reads (mock transport)');
{
  const t = new MockTransport();
  const s = new HeSession(t, FAST);

  // keyCodes: write nothing, reply [3,1,layer,row, 21×u16].
  const want = Array.from({ length: KEY_COLUMNS }, (_, i) => 0x10 + i);
  const kr = reply(3, 1, 0, 2, ...want.flatMap((c) => [c & 0xff, (c >> 8) & 0xff]));
  t.push(kr);
  const got = await s.keyCodes(0, 2);
  check('keyCodes returns 21', got.length === KEY_COLUMNS && got[0] === 0x10 && got[20] === 0x24);
  check('keyCodes sent 64B report', t.sent[0]?.length === 64 && t.sent[0]?.[0] === 3 && t.sent[0]?.[1] === 1 && t.sent[0]?.[3] === 2);

  // info(): two requests.
  const proto = reply(1, 1, 2, 5);
  const infoR = new Uint8Array(64);
  infoR.set([1, 2], 0);
  infoR.set([1, 0, 0, 7], 4);
  infoR.set([4, 5, 6, 7], 8);
  infoR.set([1, 1, 1, 1], 12);
  t.push(proto, infoR);
  const info = await s.info();
  check('info protocol', info.protocol === '2.5');
  check('info firmware', info.firmware === '4.5.6.7');
  check('info boardId', info.boardId === 0x01000007);
  check('info sent two reports', t.sent.filter((p) => p[0] === 1).length === 2);

  // liveRow: travel then status.
  const lvT = new Uint8Array(64);
  const lvS = new Uint8Array(64);
  lvT.set([4, 3, 1, 3], 0);
  lvS.set([4, 3, 3, 3], 0);
  lvT[4] = 0x10; lvT[5] = 0x27; // 10000 µm = 10 mm
  lvS[8] = 1; // col 2 actuated
  t.push(lvT, lvS);
  const live = await s.liveRow(3);
  check('liveRow travel', live[0]?.travelMm === 10 && live[2]?.actuated === true && live.length === KEY_COLUMNS);

  // lighting + palette.
  const lg = new Uint8Array(64);
  lg.set([5, 1, 0, 0, 1, 12, 80, 50, 1, 3], 0);
  const palR = new Uint8Array(64);
  palR.set([5, 1, 0, 1], 0);
  palR.set([10, 20, 30, 0, 40, 50, 60, 0], 4);
  t.push(lg, palR);
  const lighting = await s.lighting(0);
  const palette = await s.palette(0);
  check('lighting read', lighting.on && lighting.mode === 12 && lighting.colorIndex === 3);
  check('palette read', palette[0]?.r === 30 && palette[1]?.r === 60 && palette[1]?.b === 40);

  // higherKey read (mode name accepted).
  const hk = new Uint8Array(64);
  hk.set([6, 1, 1, 2, HK_MODE.tgl], 0);
  hk[5] = 0x34; hk[6] = 0x12; hk[7] = 0x09; hk[8] = 0x00;
  t.push(hk);
  const hkc = await s.higherKey(1, 2, 'tgl');
  check('higherKey read', hkc.mode === 'tgl' && (hkc.params as { kcs: number }).kcs === 0x1234);

  // macro reads.
  const mmr = reply(7, 1, 2, 1, 4, 3, 6, 5, 1);
  const mdr = new Uint8Array(64);
  mdr.set([7, 3, 1, 0], 0);
  t.push(mmr, mdr);
  const mmode = await s.macroMode(2);
  const mpage = await s.macroData(1, 0);
  check('macroMode read', mmode.valid && mmode.actNum === 0x0304 && mmode.repNum === 0x0506);
  check('macroData read', mpage.macroId === 1 && mpage.actions.length === MACRO_PAGE_ACTIONS);

  // keySlots: row replies until 0xFF terminator.
  const g0 = new Uint8Array(64);
  g0.set([3, 5, 0], 0);
  g0[3] = 1; g0[4] = 0; // col0: v=1 → size1, x0 y0
  const gEnd = reply(3, 5, 0xff, 0); // byte2 = 0xFF terminates the table
  t.push(g0, gEnd);
  const slots = await s.keySlots();
  check('keySlots terminator', slots.length === 1 && slots[0]?.row === 0);
  check('keySlots sent per-row', t.sent.filter((p) => p[0] === 3 && p[1] === 5).length === 2);
}

section('HeSession writes (mock transport, verify paths)');
{
  const t = new MockTransport();
  const s = new HeSession(t, FAST);

  // setKeyCode: write echo [3,4,...] then read-back [3,3,...,code].
  const writeEcho = reply(3, 4, 1, 2, 3, 0x34, 0x12);
  const readBack = reply(3, 3, 1, 2, 3, 0x34, 0x12);
  t.push(writeEcho, readBack);
  const out = await s.setKeyCode(1, 2, 3, 0x1234);
  check('setKeyCode verified', out.verified === true && out.command === '03/04');
  check('setKeyCode sent write', t.sent.some((p) => p[1] === 4 && p[2] === 1 && p[3] === 2 && p[4] === 3));

  // setKeyCodes mismatch → throws (not poisoned).
  const badRow = Array.from({ length: KEY_COLUMNS }, () => 0x04);
  const wr = keyRowWriteReport(0, 1, badRow);
  const wrEcho = reply(...Array.from(wr.slice(0, 8)));
  const rb = reply(3, 1, 0, 1, ...Array.from({ length: KEY_COLUMNS }, () => [0x05, 0x00]).flat());
  t.push(wrEcho, rb);
  let threw = false;
  try {
    await s.setKeyCodes(0, 1, badRow);
  } catch {
    threw = true;
  }
  check('setKeyCodes mismatch throws', threw);
  check('session not poisoned after mismatch', !s.isPoisoned);

  // setSystem verify.
  t.push(reply(2, 4, 2, 1), reply(2, 4, 1, 1));
  const sysOut = await s.setSystem(1);
  check('setSystem verified', sysOut.verified === true);

  // setReportRate no-answer → verified:false, not an error.
  const t2 = new MockTransport();
  t2.mode = 'hang';
  const s2 = new HeSession(t2, FAST);
  const rr = await s2.setReportRate(4);
  check('setReportRate unverified on no-answer', rr.verified === false && rr.command === '02/05');
  check('no-answer does not poison', !s2.isPoisoned);
}

section('HeSession failure semantics (mock transport)');
{
  // Transport errors poison after MAX_ATTEMPTS.
  const t = new MockTransport();
  t.mode = 'reject';
  const s = new HeSession(t, FAST);
  let poisoned = false;
  try {
    await s.keyCodes(0, 0);
  } catch (e) {
    poisoned = s.isPoisoned;
    check('poison message', s.poisonMessage.includes('3 attempts'), s.poisonMessage);
  }
  check('transport error poisons', poisoned);
  check('sent 3 attempts', t.sends === 3, String(t.sends));
  let blocked = false;
  try {
    await s.system();
  } catch {
    blocked = true;
  }
  check('poisoned session rejects', blocked);

  // Pure timeouts → HeNoAnswerError, no poison.
  const t2 = new MockTransport();
  t2.mode = 'hang';
  const s3 = new HeSession(t2, FAST);
  let noAnswer = false;
  try {
    await s3.system();
  } catch (e) {
    noAnswer = e instanceof HeNoAnswerError;
  }
  check('timeout → HeNoAnswerError', noAnswer);
  check('timeout does not poison', !s3.isPoisoned);

  // Non-matching reports are consumed and discarded within the attempt.
  const t3 = new MockTransport();
  const s4 = new HeSession(t3, FAST);
  t3.push(reply(2, 9, 0, 0), reply(2, 4, 1, 1)); // first reply has wrong cmd → skipped
  const sys = await s4.system();
  check('echo mismatch skipped', sys === 1);
  check('one send for skipped reply', t3.sent.length === 1, String(t3.sent.length));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nhe smoke: all checks passed');
