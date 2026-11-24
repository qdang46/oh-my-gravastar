/**
 * WebHID transport for the GravaStar Mercury HE keyboard "v2" protocol.
 *
 * Mirrors `crates/proto-he/src/lib.rs` (`omg-proto-he`, `HeKeyboard`)
 * and the vendor v2 web driver's engine class
 * (`docs/research/he-macros-research.md`):
 *
 * - device identity: VID 0x1CA6/0x31E3 × `HE_PIDS`, vendor collection
 *   usage page 0xFFB0 (same tables as `crates/hid/src/devices.rs`);
 * - transport: `sendReport(0, …)` / `receiveReport(0)` — 64-byte output
 *   reports, report id 0, replies on the input-report channel echoing
 *   `[category, command, …]` (vendor uses the whole 64-byte buffer for
 *   usage page 0xFFB0);
 * - requests serialized through a promise queue like the vendor
 *   command queue; replies matched on the echoed header prefix
 *   (2 bytes, deeper for row/col-addressed commands);
 * - timeout + retry + poison semantics mirroring `Khub916Session` in
 *   `hid.ts`: 3 attempts per request, transport errors poison the
 *   session, persistent no-answer throws `HeNoAnswerError` (the
 *   keyboard may legitimately be restarting — see `setReportRate`).
 *
 * Every write below is **code-verified, hardware-unverified** — no HE
 * keyboard was available (see docs/protocol-he-v2.md provenance). The
 * `--yes`-equivalent confirm lives at the call layer (pages), exactly
 * like the khub916 flow; the session just sends.
 */

import {
  CAT,
  GLOBAL_CMD,
  HK_OP,
  LAYOUT_CMD,
  LIGHT_CMD,
  MACRO_CMD,
  MAX_MATRIX_ROW,
  PERF_CMD,
  REPORT_BYTES,
  REPORT_RATES,
  buildReport,
  defaultLayoutReport,
  heDeviceFilters,
  higherKeyWriteReports,
  keyCodeWriteReport,
  keyRowWriteReport,
  lightingSleepWriteReport,
  lightingWriteReport,
  macroDataReport,
  macroModeReport,
  matchesHeDevice,
  paletteWriteReport,
  calibrationReport,
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
  systemWriteReport,
  reportRateWriteReport,
  normalizeReply,
  HK_MODE,
  keyPerfReport,
  type DefaultKeyLayout,
  type HigherKeyConfig,
  type HigherKeyParams,
  type HkModeName,
  type KeyPerf,
  type KeySlot,
  type KeyboardInfo,
  type LightingArea,
  type LightingBase,
  type LiveKey,
  type MacroAction,
  type MacroMode,
  type MacroPage,
  type MacroSpaceInfo,
  type Rgb,
} from './proto/he.ts';

// ── Transport abstraction ──────────────────────────────────────────────

/**
 * Minimal report transport so tests can inject a mock. `HIDDevice`
 * satisfies this once `sendReport`/`receiveReport` are present (see
 * the `declare global` augmentation below and `openHe`'s runtime check).
 */
export interface HeTransport {
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveReport(reportId: number): Promise<DataView>;
}

// Augment the global HIDDevice typing from webhid.d.ts (which only
// declares the feature-report members this app originally needed).
// Optional members: `openHe` verifies them at runtime.
declare global {
  interface HIDDevice {
    sendReport?(reportId: number, data: BufferSource | Uint8Array | number[]): Promise<void>;
    receiveReport?(reportId: number, timeout?: number): Promise<DataView>;
  }
}

// ── Constants ──────────────────────────────────────────────────────────

/** Output/input report id for the v2 protocol (report id 0 = none on wire). */
export const HE_REPORT_ID = 0;
/** Default per-attempt timeout (vendor uses ~1 s; orbit uses 600 ms). */
const DEFAULT_TIMEOUT_MS = 600;
/** Live-travel reads are polled quickly by the UI. */
const LIVE_TIMEOUT_MS = 300;
/** Calibration finish and profile switch take longer on-device. */
const CALIBRATION_TIMEOUT_MS = 2000;
const PROFILE_SWITCH_TIMEOUT_MS = 1500;
/** Polling-rate write: keyboard restarts and may drop off the bus. */
const REPORT_RATE_TIMEOUT_MS = 800;
/** Settle delay after `02 03 02` profile switch before read-back. */
const PROFILE_SETTLE_MS = 1500;
const MAX_ATTEMPTS = 3;

/** Thrown when every attempt timed out without a matching reply. */
export class HeNoAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeNoAnswerError';
  }
}

/** Internal sentinel: per-attempt deadline elapsed while waiting for a reply. */
class HeDeadline extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function dvToBytes(dv: DataView): Uint8Array {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

// ── Session ────────────────────────────────────────────────────────────

/**
 * One open HE v2 session. Reports are async; a transport error poisons
 * the session (close and reopen), mirroring `Khub916Session`.
 * All public methods are serialized through an internal queue — the
 * protocol is strictly one-request-at-a-time.
 */
export class HeSession {
  private poisoned = false;
  private poisonReason = '';
  /** Promise tail serializing every transaction. */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Single outstanding `receiveReport` promise. Kept across deadline
   * aborts so report ordering is preserved: an abandoned wait is reused
   * by the next transaction instead of leaking a stale consumer.
   */
  private rx: Promise<DataView> | null = null;
  private readonly transport: HeTransport;
  /** Per-attempt timeout for plain requests (overridable for tests). */
  private readonly timeoutMs: number;

  constructor(transport: HeTransport, opts?: { timeoutMs?: number }) {
    this.transport = transport;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /** Root cause captured when the session was poisoned (for status UI). */
  get poisonMessage(): string {
    return this.poisonReason;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ensureLive(): void {
    if (this.poisoned) {
      throw new Error(
        `the keyboard connection was interrupted (${this.poisonReason || 'transfer error'}) — reconnect and try again`,
      );
    }
  }

  /** Next input report, creating the receiveReport call lazily. */
  private pull(): Promise<DataView> {
    let p = this.rx;
    if (p === null) {
      p = this.transport
        .receiveReport(HE_REPORT_ID)
        .finally(() => {
          this.rx = null;
        });
      // Mark handled so an abandoned (deadline-losing) wait cannot
      // surface as an unhandled rejection; awaiters still see it.
      p.catch(() => {});
      this.rx = p;
    }
    return p;
  }

  /**
   * Read reports until one echoes the request prefix, or the per-attempt
   * deadline expires. Non-matching reports (unsolicited traffic, stale
   * echoes) are consumed and discarded.
   */
  private async receiveMatch(pkt: Uint8Array, matchLen: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HeDeadline();
      const dv = await Promise.race([
        this.pull(),
        sleep(remaining).then(() => {
          throw new HeDeadline();
        }),
      ]);
      const bytes = normalizeReply(dvToBytes(dv));
      if (reportEchoMatches(pkt, bytes, matchLen)) return bytes;
    }
  }

  /**
   * Send one 64-byte report and return the matching 64-byte reply.
   * `matchLen` is the echoed-prefix length (2 = category+command; deeper
   * for row/col-addressed commands). Retries `MAX_ATTEMPTS` times.
   *
   * Poison rules (mirroring hid.ts): a transport error on any attempt
   * contributes to poisoning after the retries are exhausted; a run of
   * pure timeouts throws `HeNoAnswerError` *without* poisoning — the
   * device may be restarting (polling write) or simply busy.
   */
  private async transact(
    payload: readonly number[] | Uint8Array,
    matchLen: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return this.enqueue(async () => {
      this.ensureLive();
      const pkt = buildReport(payload);
      let sawTransportError = false;
      let lastErr = 'he: no attempt made';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await this.transport.sendReport(HE_REPORT_ID, pkt);
        } catch (e) {
          sawTransportError = true;
          lastErr = e instanceof Error ? e.message : String(e);
          continue;
        }
        try {
          return await this.receiveMatch(pkt, matchLen, timeoutMs);
        } catch (e) {
          if (e instanceof HeDeadline) {
            lastErr = 'he: no answer (timeout)';
          } else {
            sawTransportError = true;
            lastErr = e instanceof Error ? e.message : String(e);
          }
        }
      }
      if (sawTransportError) {
        this.poisoned = true;
        this.poisonReason = `command failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`;
        throw new Error(
          `the keyboard connection was interrupted (${this.poisonReason})`,
        );
      }
      throw new HeNoAnswerError(
        `the keyboard did not answer [${pkt[0]?.toString(16)} ${pkt[1]?.toString(16)}] after ${MAX_ATTEMPTS} attempts`,
      );
    });
  }

  /** Request matched on category+command only (the common case). */
  private req(payload: readonly number[] | Uint8Array): Promise<Uint8Array> {
    return this.transact(payload, 2, this.timeoutMs);
  }

  /** Request with a deeper echo match (row/col-addressed commands). */
  private reqMatch(payload: readonly number[] | Uint8Array, matchLen: number, timeoutMs = this.timeoutMs): Promise<Uint8Array> {
    return this.transact(payload, matchLen, timeoutMs);
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /** Device info: `01 01` protocol version + `01 02` board info. */
  async info(): Promise<KeyboardInfo> {
    const proto = await this.transact([CAT.device, 1], 2, this.timeoutMs);
    const d = await this.transact([CAT.device, 2], 2, this.timeoutMs);
    return { protocol: parseProtocolVersion(proto), ...parseDeviceInfoReply(d) };
  }

  /**
   * Physical key geometry (`03 05 <row>` per matrix row until the
   * `0xFF` terminator byte).
   */
  async keySlots(): Promise<KeySlot[]> {
    const slots: KeySlot[] = [];
    for (let row = 0; row < MAX_MATRIX_ROW; row++) {
      const d = await this.transact([CAT.layout, LAYOUT_CMD.keyLayoutStyle, row], 2, this.timeoutMs);
      if (d[2] === 0xff) break;
      slots.push(...parseKeySlots(row, d));
    }
    return slots;
  }

  /** 16-bit keycodes of one matrix row (`03 01 <layer> <row>`, 21 cols). */
  async keyCodes(layer: number, row: number): Promise<number[]> {
    const d = await this.req([CAT.layout, LAYOUT_CMD.keyRowRead, layer, row]);
    return parseKeyCodes(d);
  }

  /** Keycode of a single key (`03 03 <layer> <row> <col>`). */
  async keyCode(layer: number, row: number, col: number): Promise<number> {
    const d = await this.reqMatch([CAT.layout, LAYOUT_CMD.keyCodeRead, layer, row, col], 5);
    return rd16(d, 5);
  }

  /** Factory-default keycodes of one row (`03 06`). */
  async defaultKeyLayout(system: number, func: number, row: number): Promise<DefaultKeyLayout> {
    const d = await this.reqMatch(defaultLayoutReport(system, func, row), 4);
    return parseDefaultLayoutReply(d);
  }

  /** Polling-rate id list (`02 05 00`). */
  async reportRates(): Promise<number[]> {
    const d = await this.req([CAT.global, GLOBAL_CMD.reportRate, 0]);
    return parseReportRateList(d);
  }

  /** Active polling-rate id (`02 05 01`); index into `REPORT_RATES`. */
  async reportRate(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.reportRate, 1]);
    return d[3] ?? 0;
  }

  /** Number of stored profiles (`02 03 00`). */
  async profileCount(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.config, 0]);
    return d[3] ?? 0;
  }

  /** Active profile index (`02 03 01`). */
  async profile(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.config, 1]);
    return d[3] ?? 0;
  }

  /** OS mode (`02 04 01`): 0 Windows, 1 macOS. */
  async system(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.system, 1]);
    return d[3] ?? 0;
  }

  /** Finest rapid-trigger step in mm (`02 0C 00`, µm wire → mm). */
  async rtPrecision(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.rtPrecision, 0]);
    return (d[3] ?? 0) / 1000;
  }

  /** Lighting zones (`02 08 00`). */
  async lightingAreas(): Promise<LightingArea[]> {
    const d = await this.req([CAT.global, GLOBAL_CMD.lightingAreas, 0]);
    return parseLightingAreas(d);
  }

  /** Lighting sleep timeout in minutes (`02 0D 01`; 0 = never). */
  async lightingSleep(): Promise<number> {
    const d = await this.req([CAT.global, GLOBAL_CMD.lightingSleep, 1]);
    return rd16(d, 3);
  }

  /** Macro storage capacity (`02 0E 00`). */
  async macroSpaceInfo(): Promise<MacroSpaceInfo> {
    const d = await this.req([CAT.global, GLOBAL_CMD.macroSpaceInfo, 0]);
    return { macroCount: d[3] ?? 0, macroNumber: rd16(d, 4) };
  }

  /** Actuation settings of one key (`04 01 <row> <col>`). */
  async keyPerf(row: number, col: number): Promise<KeyPerf> {
    const d = await this.req([CAT.performance, PERF_CMD.keyRead, row, col]);
    return parseKeyPerf(d);
  }

  /**
   * Live travel of every key in a matrix row (`04 03 01` + `04 03 03`):
   * mm + actuated flag per column.
   */
  async liveRow(row: number): Promise<LiveKey[]> {
    const travel = await this.reqMatch([CAT.performance, PERF_CMD.liveTravel, 1, row], 4, LIVE_TIMEOUT_MS);
    const status = await this.reqMatch([CAT.performance, PERF_CMD.liveTravel, 3, row], 4, LIVE_TIMEOUT_MS);
    return parseLiveRow(travel, status);
  }

  /**
   * Advanced-key config of one key (`06 01 <row> <col> <mode>`); the
   * reply's own mode byte selects the decode. Hardware-unverified.
   */
  async higherKey(row: number, col: number, mode: number | HkModeName): Promise<HigherKeyConfig> {
    const modeByte = typeof mode === 'string' ? HK_MODE[mode] : mode;
    const d = await this.reqMatch([CAT.higherKey, HK_OP.read, row, col, modeByte], 5);
    const cfg = parseHigherKey(d);
    if (cfg === null) {
      throw new Error(`he: unknown higher-key reply mode ${d[4]}`);
    }
    return cfg;
  }

  /** Macro slot header (`07 01 <id>`). Hardware-unverified. */
  async macroMode(id: number): Promise<MacroMode> {
    const d = await this.reqMatch([CAT.macro, MACRO_CMD.modeRead, id & 0xff], 3);
    return parseMacroModeReply(d);
  }

  /** One page (≤15 actions) of macro `id` at `offset` (`07 03`). */
  async macroData(id: number, offset: number): Promise<MacroPage> {
    const d = await this.reqMatch([CAT.macro, MACRO_CMD.dataRead, id & 0xff, offset & 0xff], 4);
    return parseMacroPage(d);
  }

  /** Lighting effect settings of a zone (`05 01 <zone> 00`). */
  async lighting(area: number): Promise<LightingBase> {
    const d = await this.req([CAT.lighting, LIGHT_CMD.read, area & 0xff, LIGHT_CMD.whatEffect]);
    return parseLighting(d);
  }

  /** 8-colour palette of a zone (`05 01 <zone> 01`, wire order B,G,R,H). */
  async palette(area: number): Promise<Rgb[]> {
    const d = await this.req([CAT.lighting, LIGHT_CMD.read, area & 0xff, LIGHT_CMD.whatPalette]);
    return parsePalette(d);
  }

  // ── Writes ─────────────────────────────────────────────────────────
  //
  // Every write below is **code-verified, hardware-unverified** (ported
  // from orbit + vendor JS; no HE keyboard was exercised). Each performs
  // a read-back verify per the repo safety contract; the only exception
  // is `setReportRate`, where the keyboard restarts and drops off the
  // bus — a missing read-back is reported `verified: false`, not an
  // error (same carve-out as `kb polling set` in the Rust CLI).

  /**
   * Write all 21 keycodes of one matrix row (`03 02`). Blacklisted
   * keycodes rejected. Verify: `keyCodes` read-back must match.
   */
  async setKeyCodes(layer: number, row: number, codes: readonly number[]): Promise<WriteOutcome> {
    const pkt = keyRowWriteReport(layer, row, codes);
    await this.req(pkt);
    const back = await this.keyCodes(layer, row);
    const ok = back.length === codes.length && codes.every((c, i) => back[i] === c);
    if (!ok) throw new Error('the key row change was not saved — the keyboard did not confirm it');
    return { command: '03/02', verified: true };
  }

  /**
   * Write the keycode of a single key (`03 04`). Blacklisted keycodes
   * rejected. Verify: `keyCode` read-back must match.
   */
  async setKeyCode(layer: number, row: number, col: number, code: number): Promise<WriteOutcome> {
    const pkt = keyCodeWriteReport(layer, row, col, code);
    await this.req(pkt);
    const back = await this.keyCode(layer, row, col);
    if (back !== (code & 0xffff)) {
      throw new Error('the key change was not saved — the keyboard did not confirm it');
    }
    return { command: '03/04', verified: true };
  }

  /**
   * Switch the active profile (`02 03 02 <index>`). The firmware
   * reloads the profile; settle 1.5 s then verify `profile()`.
   */
  async setProfile(index: number): Promise<WriteOutcome> {
    await this.reqMatch(profileSwitchReport(index), 2, PROFILE_SWITCH_TIMEOUT_MS);
    await sleep(PROFILE_SETTLE_MS);
    const back = await this.profile();
    if (back !== (index & 0xff)) {
      throw new Error('the profile change was not saved — the keyboard did not confirm it');
    }
    return { command: '02/03', verified: true };
  }

  /** Set the OS mode (`02 04 02 <v>`; 0 Windows, 1 macOS). Verify: `system()`. */
  async setSystem(value: number): Promise<WriteOutcome> {
    await this.req(systemWriteReport(value));
    const back = await this.system();
    if (back !== (value & 0xff)) {
      throw new Error('the OS mode change was not saved — the keyboard did not confirm it');
    }
    return { command: '02/04', verified: true };
  }

  /**
   * Set the polling rate (`02 05 02 <id>`). **The keyboard restarts and
   * drops off the bus** — a missing read-back is reported
   * `verified: false`, not an error (documented exception, same as the
   * Rust CLI's `kb polling set`).
   */
  async setReportRate(id: number): Promise<WriteOutcome> {
    try {
      await this.reqMatch(reportRateWriteReport(id), 2, REPORT_RATE_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof HeNoAnswerError) {
        return { command: '02/05', verified: false };
      }
      throw e;
    }
    // Best-effort read-back after the restart settles.
    await sleep(1500);
    try {
      const back = await this.reportRate();
      return { command: '02/05', verified: back === (id & 0xff) };
    } catch {
      return { command: '02/05', verified: false };
    }
  }

  /** Set the lighting sleep timeout (`02 0D 00 <lo> <hi>`, minutes). Verify: `lightingSleep()`. */
  async setLightingSleep(minutes: number): Promise<WriteOutcome> {
    await this.req(lightingSleepWriteReport(minutes));
    const back = await this.lightingSleep();
    if (back !== (minutes & 0xffff)) {
      throw new Error('the lighting sleep change was not saved — the keyboard did not confirm it');
    }
    return { command: '02/0D', verified: true };
  }

  /**
   * Start (true) or finish (false) travel calibration (`02 06 00`/`01`).
   * Device operation — no read-back path exists. Callers must keep the
   * `--yes` confirm at the UI layer.
   */
  async calibration(start: boolean): Promise<void> {
    await this.reqMatch(calibrationReport(start), 2, CALIBRATION_TIMEOUT_MS);
  }

  /**
   * Write one key's actuation settings (`04 02 <row> <col> …`). The
   * switch echo fields (axis/calibrate/axisV2Id/axisRangeMax/
   * axisCoefficient) must be carried over from a prior `keyPerf` read —
   * this is the caller's read-modify-write responsibility, like the
   * Rust `kb perf set`. Verify: `keyPerf` read-back must match.
   */
  async setKeyPerf(row: number, col: number, p: KeyPerf): Promise<WriteOutcome> {
    const pkt = keyPerfReport(row, col, p);
    await this.req(pkt);
    const back = await this.keyPerf(row, col);
    if (!keyPerfEquals(back, p)) {
      throw new Error('the actuation change was not saved — the keyboard did not confirm it');
    }
    return { command: '04/02', verified: true };
  }

  /** Write a zone's lighting effect (`05 02 <zone> 00 …`). Verify: `lighting()`. */
  async setLighting(area: number, l: LightingBase): Promise<WriteOutcome> {
    await this.req(lightingWriteReport(area, l));
    const back = await this.lighting(area);
    if (!lightingEquals(back, l)) {
      throw new Error('the lighting change was not saved — the keyboard did not confirm it');
    }
    return { command: '05/02', verified: true };
  }

  /** Write a zone's 8-colour palette (`05 02 <zone> 01 …`). Verify: `palette()`. */
  async setPalette(area: number, colors: readonly Rgb[]): Promise<WriteOutcome> {
    await this.req(paletteWriteReport(area, colors));
    const back = await this.palette(area);
    const want = colors.slice(0, 8);
    const ok =
      back.length === want.length &&
      want.every((c, i) => {
        const b = back[i];
        return b !== undefined && b.r === (c.r & 0xff) && b.g === (c.g & 0xff) && b.b === (c.b & 0xff);
      });
    if (!ok) {
      throw new Error('the palette change was not saved — the keyboard did not confirm it');
    }
    return { command: '05/02', verified: true };
  }

  /**
   * Write a key's advanced-key config (`06 02 …`). SOCD/RS are
   * cross-linked two-packet writes sent sequentially. Returns the
   * decoded echo of each packet (one entry, or two for SOCD/RS) — the
   * echoes are the vendor's only confirmation; there is no separate
   * read-back compare (matches `HeKeyboard::set_higher_key`).
   */
  async setHigherKey(row: number, col: number, params: HigherKeyParams): Promise<HigherKeyConfig[]> {
    const out: HigherKeyConfig[] = [];
    for (const pkt of higherKeyWriteReports(row, col, params)) {
      const d = await this.req(pkt);
      const cfg = parseHigherKey(d);
      if (cfg === null) {
        throw new Error(`he: unknown higher-key reply mode ${d[4]}`);
      }
      out.push(cfg);
    }
    return out;
  }

  /** Write a macro slot header (`07 02`). Verify: `macroMode()` read-back. */
  async setMacroMode(m: MacroMode): Promise<WriteOutcome> {
    await this.req(macroModeReport(m));
    const back = await this.macroMode(m.macroId);
    if (
      back.valid !== m.valid ||
      back.actNum !== (m.actNum & 0xffff) ||
      back.repNum !== (m.repNum & 0xffff) ||
      back.mode !== (m.mode & 0xff)
    ) {
      throw new Error('the macro header change was not saved — the keyboard did not confirm it');
    }
    return { command: '07/02', verified: true };
  }

  /**
   * Write one page of macro actions (`07 04`, ≤15 actions). Verify:
   * `macroData()` read-back — the reply always carries 15 slots, so
   * compare only the written prefix.
   */
  async setMacroData(id: number, offset: number, actions: readonly MacroAction[]): Promise<WriteOutcome> {
    await this.req(macroDataReport(id, offset, actions));
    const back = await this.macroData(id, offset);
    const ok = actions.every((a, i) => {
      const b = back.actions[i];
      return b !== undefined && b.status === a.status && b.delay === a.delay && b.keyCode === (a.keyCode & 0xffff);
    });
    if (!ok) {
      throw new Error('the macro data was not saved — the keyboard did not confirm it');
    }
    return { command: '07/04', verified: true };
  }
}

function keyPerfEquals(a: KeyPerf, b: KeyPerf): boolean {
  const eps = 1e-4;
  const close = (x: number, y: number) => Math.abs(x - y) < eps;
  return (
    a.mode === b.mode &&
    close(a.normalPress, b.normalPress) &&
    close(a.normalRelease, b.normalRelease) &&
    close(a.rtFirstTouch, b.rtFirstTouch) &&
    close(a.rtPress, b.rtPress) &&
    close(a.rtRelease, b.rtRelease) &&
    close(a.pressDeadzone, b.pressDeadzone) &&
    close(a.releaseDeadzone, b.releaseDeadzone) &&
    a.axis === b.axis &&
    a.calibrate === b.calibrate &&
    a.axisV2Id === b.axisV2Id &&
    a.axisRangeMax === b.axisRangeMax &&
    a.axisCoefficient === b.axisCoefficient
  );
}

function lightingEquals(a: LightingBase, b: LightingBase): boolean {
  return (
    a.on === b.on &&
    a.mode === b.mode &&
    a.brightness === b.brightness &&
    a.speed === b.speed &&
    a.direction === b.direction &&
    a.colorIndex === b.colorIndex
  );
}

// ── Result + connect flow ──────────────────────────────────────────────

/** Result of a verified write (mirrors hid.ts `WriteOutcome`). */
export interface WriteOutcome {
  /** Wire command as `"cat/sub"` hex-ish label, e.g. `"05/02"`. */
  command: string;
  verified: boolean;
}

export interface ConnectedHe {
  device: HIDDevice;
  collection: HIDCollection;
  session: HeSession;
}

/**
 * Find the HE v2 collection on an opened device: usage page 0xFFB0,
 * preferring the shallowest collection that has both output and input
 * reports (the config interface; normal typing uses another collection).
 */
export function pickHeCollection(device: HIDDevice): HIDCollection | null {
  const matches: { collection: HIDCollection; depth: number }[] = [];
  const walk = (c: HIDCollection, depth: number): void => {
    if (c.usagePage === 0xffb0) {
      if (c.outputReports.length > 0 && c.inputReports.length > 0) {
        matches.push({ collection: c, depth });
      }
    }
    for (const child of c.children) walk(child, depth + 1);
  };
  for (const top of device.collections) walk(top, 0);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.depth - b.depth);
  return matches[0]?.collection ?? null;
}

/**
 * Open a picked HIDDevice as an HE v2 session. Throws when the device
 * is not a known HE identity, lacks the 0xFFB0 collection, or does not
 * expose `sendReport`/`receiveReport`.
 */
export async function openHe(device: HIDDevice): Promise<ConnectedHe> {
  const collection = pickHeCollection(device);
  if (!collection || !matchesHeDevice(device.vendorId, device.productId, collection.usagePage)) {
    throw new Error('that device does not look like a supported GravaStar HE keyboard');
  }
  if (typeof device.sendReport !== 'function' || typeof device.receiveReport !== 'function') {
    throw new Error('this browser cannot send plain HID output reports — try Chrome or Edge');
  }
  const transport: HeTransport = {
    sendReport: (id, data) => device.sendReport!(id, data),
    receiveReport: (id) => device.receiveReport!(id),
  };
  await device.open();
  try {
    return { device, collection, session: new HeSession(transport) };
  } catch (e) {
    await device.close().catch(() => {});
    throw e;
  }
}

/**
 * Close and re-open an already-granted device. Used to recover from a
 * poisoned session without a user gesture (device permission persists
 * per origin).
 */
export async function reopenHe(device: HIDDevice): Promise<ConnectedHe> {
  await device.close().catch(() => {});
  return openHe(device);
}

/**
 * Prompt the user to pick an HE v2 device. Returns null when the user
 * cancels the picker.
 */
export async function requestHeDevice(): Promise<HIDDevice | null> {
  if (!('hid' in navigator)) return null;
  const devices = await navigator.hid.requestDevice({ filters: heDeviceFilters() });
  return devices[0] ?? null;
}

export { REPORT_RATES, CAT as HE_CAT, REPORT_BYTES as HE_REPORT_BYTES };
