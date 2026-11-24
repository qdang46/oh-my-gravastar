/**
 * Dashboard — the app's landing page (docs/UIUX-SPEC.md §2.1, bead `utk`).
 *
 * Stateless renderer like `renderDevice`: rebuilt on every state emit by
 * `initPages`. Shows:
 *
 *   - device overview (model / firmware / battery / link state)
 *   - current profile summary (lighting mode, sleep, active layer)
 *   - quick actions — capability-gated nav shortcuts + disconnect
 *   - health strip — capability-state counts + warnings (write gate,
 *     unverified features)
 *   - recent changes — tail of the safety audit log (empty → hint)
 *
 * Draft state note: per-page unsaved drafts (lighting `dirty`, macro
 * `draft`, remap `StagedEdits`) are private to their page modules and are
 * not centrally observable, so this page reports the *device-read*
 * profile only — it never claims "unsaved changes" it cannot see.
 */

import { app, connect, disconnect, emit } from './state.ts';
import { fnDoctorReport } from './fn-doctor.ts';
import type { FnDoctorReport } from './fn-doctor-core.ts';
import { formatVidPid } from './hid.ts';
import { decodeLightState, lightModeInfo } from './proto/light.ts';
import {
  CAPABILITY_KEYS,
  getCapabilities,
  protocolOf,
  type CapabilityMap,
  type CapabilityState,
} from './core/capabilities.ts';
import type { DeviceLike } from './core/device-model.ts';
import { isFeatureAvailable, type FeatureId } from './core/feature-registry.ts';
import { AuditLog } from './safety/audit-log.ts';
import { profileSwitcherSummary } from './profile-switcher.ts';

// ── DOM helpers (same style as pages.ts) ───────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function card(title: string): { card: HTMLElement; body: HTMLElement } {
  const c = el('section', 'card');
  c.append(el('h2', '', title));
  const body = el('div', 'card-body');
  c.append(body);
  return { card: c, body };
}

function kv(dl: HTMLElement, key: string, value: string): void {
  const dt = el('dt', '', key);
  dt.dataset.k = key.toLowerCase().replace(/\s+/g, '-');
  dl.append(dt, el('dd', '', value));
}

// ── Capability summary (local helper — core/capabilities has no
//    "summary for device" API and is owned elsewhere) ──────────────────

interface CapSummary {
  counts: Record<CapabilityState, number>;
  /** Human labels of `unverified`/`experimental` features with reasons. */
  caveats: string[];
}

function capabilitySummary(map: CapabilityMap): CapSummary {
  const counts: Record<CapabilityState, number> = {
    supported: 0,
    'unsupported-hardware': 0,
    'unsupported-firmware': 0,
    'protocol-unknown': 0,
    experimental: 0,
    unverified: 0,
  };
  const caveats: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    const cap = map[key];
    if (!cap) continue;
    counts[cap.state] += 1;
    if ((cap.state === 'unverified' || cap.state === 'experimental') && cap.reason) {
      caveats.push(`${key.replace(/_/g, ' ')} — ${cap.reason}`);
    }
  }
  return { counts, caveats };
}

const PROTOCOL_LABEL: Record<string, string> = {
  'khub916': 'GravaStar khub916',
  'he-v2': 'HE keyboard v2',
  compx: 'Compx mouse',
  sparkplayjoy: 'SparkPlayJoy analog',
  unknown: 'unrecognised',
};

// ── Fn-layer doctor result (bead yw0) ─────────────────────────────────
// Fetched once per connected device (fnDoctorReport is memoized); a bad
// verdict adds a health-strip warning. Read-only — the check only reads
// keymap args 0x01/0x00 through the session cache.
let fnDocConn: unknown = null;
let fnDocReport: FnDoctorReport | null = null;
let fnDocRequested = false;

/** Kick off the Fn-layer check for the current connection (idempotent). */
function maybeFetchFnDoctor(available: boolean): void {
  const conn = app.connected;
  if (!available || !conn) return;
  if (fnDocRequested && fnDocConn === conn) return;
  fnDocRequested = true;
  fnDocConn = conn;
  fnDocReport = null;
  void fnDoctorReport()
    .then((r) => {
      if (app.connected !== conn) return;
      fnDocReport = r;
      // One repaint so the warning appears without waiting for a
      // user action; fnDoctorReport is memoized so this converges.
      emit();
    })
    .catch(() => {
      /* check failed — stay silent; Diagnostics shows the error */
    });
}

// ── Page ───────────────────────────────────────────────────────────────

export function renderDashboard(root: HTMLElement): void {
  root.replaceChildren();

  const snap = app.snapshot;
  if (!app.connected || !snap) {
    const { card: c, body } = card('Dashboard');
    body.append(
      el('p', 'coming-soon', 'No keyboard connected.'),
      el(
        'p',
        'hint',
        'Plug in your GravaStar keyboard with a USB cable, then press ' +
          'Connect at the top right. This page shows device health, your ' +
          'current profile and quick shortcuts once connected.',
      ),
    );
    const connectBtn = el('button', 'primary', 'Connect keyboard');
    connectBtn.type = 'button';
    connectBtn.disabled = app.busy;
    connectBtn.addEventListener('click', () => void connect());
    body.append(connectBtn);
    root.append(c);
    return;
  }

  const dev = app.connected.device;
  // DeviceLike for detection: snapshot info (uuid → khub916) plus the
  // HID descriptor fields (VID/PID transport, product name).
  const like: DeviceLike = {
    vendorId: dev.vendorId,
    productId: dev.productId,
    productName: dev.productName ?? null,
    uuid: snap.info.uuid,
    catalogModel: snap.info.catalogModel,
    catalogName: snap.info.catalogName,
    screenSize: snap.info.screenSize,
  };
  const caps = getCapabilities(like);
  const summary = capabilitySummary(caps);

  // Fn-layer doctor (read-only): only meaningful on khub916 devices
  // with a readable keymap. Runs once per connection; a bad verdict
  // surfaces in the health strip below.
  maybeFetchFnDoctor(
    protocolOf(like) === 'khub916' && isFeatureAvailable(caps, 'keymap-editor'),
  );

  // ── Device overview ────────────────────────────────────────────────
  const infoCard = card('Device');
  const dl = el('dl', 'kv');
  kv(dl, 'Model', app.deviceLabel || snap.info.catalogName || 'Unknown model');
  kv(dl, 'Firmware', snap.info.versionHex);
  kv(dl, 'Battery', `${snap.power.percent}%`);
  kv(dl, 'Protocol', PROTOCOL_LABEL[protocolOf(like)] ?? protocolOf(like));
  kv(
    dl,
    'Connection',
    `${formatVidPid(dev)} · ${dev.productName ?? dev.manufacturerName ?? 'HID device'}`,
  );
  kv(
    dl,
    'Link state',
    app.reconnectedSilently || app.connected.session.writesBlocked
      ? 'Reconnected — changes blocked'
      : 'Connected',
  );
  infoCard.body.append(dl);
  root.append(infoCard.card);

  // ── Current profile ────────────────────────────────────────────────
  const profCard = card('Current profile');
  const pdl = el('dl', 'kv');
  const light = decodeLightState(snap.profile.raw);
  const lightName = light ? (lightModeInfo(light.mode)?.name ?? `effect ${light.mode}`) : null;
  kv(pdl, 'Lighting', lightName ?? '—');
  if (light) {
    kv(pdl, 'Speed', String(light.speed));
    kv(pdl, 'Brightness', String(light.brightness));
  }
  kv(pdl, 'Sleep timer', snap.profile.sleepSeconds !== null ? `${snap.profile.sleepSeconds} s` : '—');
  kv(pdl, 'Key layer', `Layer ${app.layer + 1} of 4`);
  // Named game/app profiles (bead 0hl): which saved profile was last
  // applied — manual switching only, a browser page cannot detect the
  // foreground app (see the Backup & restore → Game & app profiles card).
  const sw = profileSwitcherSummary();
  kv(
    pdl,
    'Saved profile',
    sw.activeName
      ? `${sw.activeName}${sw.switchCount ? ` · ${sw.switchCount} switch(es) logged` : ''}`
      : '—',
  );
  profCard.body.append(pdl);
  profCard.body.append(
    el(
      'p',
      'hint',
      'Unsaved edits live inside each editor (Keys, Lighting, Macro) and ' +
        'are not tracked here — open a section to see its dirty state.',
    ),
  );
  profCard.body.append(
    el(
      'p',
      'hint',
      'Named game/app profiles can be applied manually on the Backup & ' +
        'restore page — automatic per-app switching is not possible from ' +
        'a browser page.',
    ),
  );
  root.append(profCard.card);

  // ── Quick actions ──────────────────────────────────────────────────
  // Only features the connected device supports get a shortcut
  // (UIUX-SPEC §3: capability-driven UI).
  const actions: { path: string; title: string; blurb: string; feature?: FeatureId }[] = [
    { path: '/lighting', title: 'Lighting', blurb: 'Effects, colours, scenes', feature: 'lighting-studio' },
    { path: '/keys', title: 'Keys', blurb: 'Key assignments & layers', feature: 'keymap-editor' },
    { path: '/macro', title: 'Macro', blurb: 'Macros & timing', feature: 'macro-studio' },
    { path: '/advanced', title: 'Advanced', blurb: 'SOCD / timers / toggles', feature: 'adv-keys' },
    { path: '/music', title: 'Music', blurb: 'Mic-reactive lighting', feature: 'music-reactive' },
    { path: '/device', title: 'Device', blurb: 'Details, backup & restore' },
  ];
  const qaCard = card('Quick actions');
  const grid = el('div', 'dash-actions');
  for (const a of actions) {
    if (a.feature && !isFeatureAvailable(caps, a.feature)) continue;
    const link = el('a', 'dash-action');
    link.href = `#${a.path}`;
    link.append(el('span', 'dash-action-title', a.title), el('span', 'dash-action-blurb', a.blurb));
    grid.append(link);
  }
  qaCard.body.append(grid);
  const disconnectBtn = el('button', 'danger', 'Disconnect');
  disconnectBtn.type = 'button';
  disconnectBtn.addEventListener('click', () => void disconnect());
  qaCard.body.append(disconnectBtn);
  root.append(qaCard.card);

  // ── Health strip ───────────────────────────────────────────────────
  const healthCard = card('Device health');
  const hdl = el('dl', 'kv');
  const avail = summary.counts.supported + summary.counts.experimental + summary.counts.unverified;
  kv(hdl, 'Features available', `${avail} of ${CAPABILITY_KEYS.length}`);
  kv(hdl, 'Not supported', String(summary.counts['unsupported-hardware'] + summary.counts['unsupported-firmware']));
  kv(hdl, 'Unverified', String(summary.counts.unverified + summary.counts.experimental));
  healthCard.body.append(hdl);
  const warnings: string[] = [];
  if (app.reconnectedSilently || app.connected.session.writesBlocked) {
    warnings.push(
      'This session started read-only — press "Enable editing" in the banner ' +
        'to allow changes.',
    );
  }
  warnings.push(...summary.caveats.map((c) => `Unverified: ${c}.`));
  if (
    fnDocConn === app.connected &&
    fnDocReport &&
    !fnDocReport.intact
  ) {
    warnings.push(
      `Fn layer check: ${fnDocReport.summary} — see Diagnostics for the full report.`,
    );
  }
  if (warnings.length === 0) {
    healthCard.body.append(el('p', 'hint ok', 'No warnings — everything reported is verified or expected.'));
  } else {
    const ul = el('ul', 'dash-warnings');
    for (const w of warnings) ul.append(el('li', '', w));
    healthCard.body.append(ul);
  }
  root.append(healthCard.card);

  // ── Recent changes (audit-log tail; empty is normal — the executor
  //    only writes here once transactions are wired to a sink) ────────
  const recentCard = card('Recent changes');
  let entries: ReturnType<AuditLog['tail']> = [];
  try {
    entries = new AuditLog().tail(8);
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    recentCard.body.append(el('p', 'hint', 'No changes recorded yet this session.'));
  } else {
    const ul = el('ul', 'dash-audit');
    for (const e of entries) {
      const when = (() => {
        try {
          return new Date(e.ts).toLocaleString();
        } catch {
          return e.ts;
        }
      })();
      ul.append(
        el(
          'li',
          '',
          `${when} — ${e.op} (${e.result})${e.detail ? `: ${e.detail}` : ''}`,
        ),
      );
    }
    recentCard.body.append(ul);
  }
  root.append(recentCard.card);
}
