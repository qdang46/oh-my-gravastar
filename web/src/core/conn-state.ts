/**
 * Connection state machine (spec §4) — a small, pure, typed model of the
 * link between the app and the device. DOM-free and storage-free so
 * `scripts/test-conn-state.ts` can exercise every transition under Node.
 *
 * The machine does not own the connection — `state/connection.ts` does.
 * It *derives* the user-facing phase from the inputs the app already
 * tracks, and encodes the safety rules:
 *
 *   - a reconnect NEVER replays queued writes: every read-only phase
 *     reports `writesAllowed: false` until the user explicitly re-enables
 *     editing (`enableEditing` / manual Connect);
 *   - an interrupted write lands in `write-uncertain`: the outcome is
 *     unknown until a fresh read confirms device state, so writes stay
 *     blocked (`requiresFreshRead: true`);
 *   - `disconnected-mid-op` is the same hazard seen from the other side:
 *     the device dropped while a write was in flight.
 *
 * `deriveConnectionPhase()` is the single source for the phase chip in
 * the shell and for "may I write?" gating helpers in pages.
 */

// ── Phases ────────────────────────────────────────────────────────────

/**
 * User-facing connection phases (spec §4 "Connection states"):
 *
 *   disconnected            no session at all
 *   picker-open             the browser's WebHID picker is showing
 *   connecting              a session is being opened / snapshot loading
 *   connected-read-only     live session, writes gated (not a reconnect)
 *   editing-enabled         live session, writes allowed
 *   reconnect-read-only     session came up silently (auto/hot-plug or
 *                           poison recovery) — read-only until re-approved
 *   device-busy-runtime     a runtime feature owns the device (music stream)
 *   disconnected-mid-op     the link dropped while a write was in flight
 *   write-uncertain         a write was interrupted; fresh read required
 *   unsupported             device/firmware we do not drive
 */
export type ConnectionPhase =
  | 'disconnected'
  | 'picker-open'
  | 'connecting'
  | 'connected-read-only'
  | 'editing-enabled'
  | 'reconnect-read-only'
  | 'device-busy-runtime'
  | 'disconnected-mid-op'
  | 'write-uncertain'
  | 'unsupported';

/** Structural input — callers pass a snapshot of `app` fields. */
export interface ConnStateInput {
  /** A live session exists (`app.connected !== null`). */
  connected: boolean;
  /** A connect/open/refresh is in flight (`app.busy` during connect). */
  connecting?: boolean;
  /** The WebHID device picker dialog is currently open. */
  pickerOpen?: boolean;
  /** Session write gate is closed (`session.writesBlocked`). */
  writesBlocked?: boolean;
  /** Session arrived via silent auto/hot-plug connect or poison recovery. */
  reconnectedSilently?: boolean;
  /** A runtime feature owns the device (e.g. `app.musicActive`). */
  runtimeActive?: boolean;
  /**
   * The detected protocol/firmware is one we can drive. Pass `false`
   * for unrecognised devices; omit when unknown-but-connected (the
   * capability layer handles per-feature honesty instead).
   */
  supported?: boolean;
  /** A device write is currently executing. */
  opInFlight?: boolean;
  /**
   * A previous write ended without a confirmed outcome (transport error
   * mid-write). Cleared only by a successful fresh read.
   */
  uncertainWrite?: boolean;
}

// ── Phase metadata ────────────────────────────────────────────────────

export type PhaseTone = 'ok' | 'warn' | 'error' | 'muted' | 'info';

export interface PhaseMeta {
  /** i18n key for the short user-facing label (see i18n `phase.*`). */
  labelKey: string;
  tone: PhaseTone;
  /**
   * Whether device writes may proceed in this phase. Read-only and
   * uncertain phases are always false — reconnects never replay and an
   * interrupted write must be re-read before any retry.
   */
  writesAllowed: boolean;
  /** True when the phase demands a fresh device read before writes. */
  requiresFreshRead: boolean;
  /** One-line explanation for tooltips / the phase chip title. */
  hintKey: string;
}

const PHASE_META: Record<ConnectionPhase, PhaseMeta> = {
  disconnected: {
    labelKey: 'phase.disconnected',
    tone: 'muted',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.disconnected',
  },
  'picker-open': {
    labelKey: 'phase.picker-open',
    tone: 'info',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.picker-open',
  },
  connecting: {
    labelKey: 'phase.connecting',
    tone: 'info',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.connecting',
  },
  'connected-read-only': {
    labelKey: 'phase.connected-read-only',
    tone: 'warn',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.connected-read-only',
  },
  'editing-enabled': {
    labelKey: 'phase.editing-enabled',
    tone: 'ok',
    writesAllowed: true,
    requiresFreshRead: false,
    hintKey: 'phase.hint.editing-enabled',
  },
  'reconnect-read-only': {
    labelKey: 'phase.reconnect-read-only',
    tone: 'warn',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.reconnect-read-only',
  },
  'device-busy-runtime': {
    labelKey: 'phase.device-busy-runtime',
    tone: 'info',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.device-busy-runtime',
  },
  'disconnected-mid-op': {
    labelKey: 'phase.disconnected-mid-op',
    tone: 'error',
    writesAllowed: false,
    requiresFreshRead: true,
    hintKey: 'phase.hint.disconnected-mid-op',
  },
  'write-uncertain': {
    labelKey: 'phase.write-uncertain',
    tone: 'error',
    writesAllowed: false,
    requiresFreshRead: true,
    hintKey: 'phase.hint.write-uncertain',
  },
  unsupported: {
    labelKey: 'phase.unsupported',
    tone: 'error',
    writesAllowed: false,
    requiresFreshRead: false,
    hintKey: 'phase.hint.unsupported',
  },
};

export function phaseMeta(phase: ConnectionPhase): PhaseMeta {
  return PHASE_META[phase];
}

/** True when writes may proceed — single gate for UI affordances. */
export function canWrite(phase: ConnectionPhase): boolean {
  return PHASE_META[phase].writesAllowed;
}

// ── Derivation ────────────────────────────────────────────────────────

/**
 * Reduce the live app inputs to a single phase. Priority order matters:
 *
 *   1. disconnected-mid-op / write-uncertain — a write hazard outranks
 *      everything else; the user must re-read before trusting the device.
 *   2. picker-open / connecting — transient connect states while
 *      disconnected.
 *   3. unsupported — connected but not a device we drive.
 *   4. device-busy-runtime — a runtime feature owns the link.
 *   5. reconnect-read-only vs connected-read-only vs editing-enabled —
 *      the write-gate tri-state.
 *
 * Reconnect safety: `reconnectedSilently`/`writesBlocked` can only ever
 * produce read-only phases here; there is no input that flips a
 * reconnected session straight to `editing-enabled` — that requires the
 * explicit `enableEditing()` path, which clears the flags.
 */
export function deriveConnectionPhase(input: ConnStateInput): ConnectionPhase {
  const opHazard = input.opInFlight === true || input.uncertainWrite === true;

  if (!input.connected) {
    if (opHazard) return 'disconnected-mid-op';
    if (input.pickerOpen) return 'picker-open';
    if (input.connecting) return 'connecting';
    return 'disconnected';
  }

  // Connected.
  if (input.uncertainWrite) return 'write-uncertain';
  if (input.supported === false) return 'unsupported';
  if (input.runtimeActive) return 'device-busy-runtime';
  if (input.reconnectedSilently || input.writesBlocked) {
    // A silent session is always a reconnect-read-only; a gate closed by
    // other means (poison recovery without the flag, future read-only
    // sessions) reports as plain read-only.
    return input.reconnectedSilently ? 'reconnect-read-only' : 'connected-read-only';
  }
  return 'editing-enabled';
}

/**
 * Convenience wrapper over the `app` store shape — kept structural so
 * this module never imports `state.ts` (avoids a core→state cycle and
 * keeps the tests DOM-free).
 */
export interface AppLike {
  connected: { session?: { writesBlocked?: boolean } | null } | null;
  busy: boolean;
  musicActive: boolean;
  reconnectedSilently: boolean;
  connectStage?: 'idle' | 'picker' | 'connecting';
}

export function phaseFromApp(app: AppLike, extra?: Partial<ConnStateInput>): ConnectionPhase {
  return deriveConnectionPhase({
    connected: app.connected !== null,
    connecting: app.busy && app.connectStage === 'connecting',
    pickerOpen: app.busy && app.connectStage === 'picker',
    writesBlocked: app.connected?.session?.writesBlocked === true,
    reconnectedSilently: app.reconnectedSilently,
    runtimeActive: app.musicActive,
    ...extra,
  });
}
