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
import { t } from './i18n/index.ts';
import { statusKindFor, statusTag } from './ui/status.ts';
import { SnapshotStore } from './safety/snapshots.ts';
import { ProfileHistory } from './profile-history.ts';
import { fnDoctorReport } from './fn-doctor.ts';
import type { FnDoctorReport } from './fn-doctor-core.ts';
import { decodeLightState, lightModeInfo } from './proto/light.ts';
import {
  CAPABILITY_KEYS,
  getCapabilities,
  protocolOf,
  type CapabilityMap,
  type CapabilityState,
} from './core/capabilities.ts';
import type { DeviceLike } from './core/device-model.ts';
import { isFeatureAvailable, describeFeature, type FeatureId } from './core/feature-registry.ts';
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
    // First-run / disconnected state (spec §4): plain language only —
    // no HID, VID/PID, protocol or JSON jargon. Explains the direct
    // browser connection, the requirements, what happens on Connect,
    // and that every change asks for approval first.
    const { card: c, body } = card(t('onboard.title'));
    body.append(el('p', 'hint', t('onboard.intro')));

    const req = el('div', 'onboard-req');
    req.append(el('h3', 'onboard-req-title', t('onboard.reqTitle')));
    const reqList = el('ul', 'onboard-steps');
    for (const key of ['onboard.req1', 'onboard.req2', 'onboard.req3'] as const) {
      reqList.append(el('li', '', t(key)));
    }
    req.append(reqList);
    body.append(req);

    const steps = el('ol', 'onboard-steps');
    for (const key of ['onboard.stepConnect', 'onboard.stepIdentify', 'onboard.stepSafe'] as const) {
      steps.append(el('li', '', t(key)));
    }
    body.append(steps);

    const connectBtn = el('button', 'primary', app.busy ? t('onboard.busy') : t('onboard.cta'));
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
  const infoCard = card(t('dash.device'));
  const dl = el('dl', 'kv');
  kv(dl, t('dash.model'), app.deviceLabel || snap.info.catalogName || 'Unknown model');
  kv(dl, t('dash.firmware'), snap.info.versionHex);
  kv(dl, t('dash.battery'), `${snap.power.percent}%`);
  kv(dl, t('dash.protocol'), PROTOCOL_LABEL[protocolOf(like)] ?? protocolOf(like));
  kv(
    dl,
    t('dash.linkState'),
    app.reconnectedSilently || app.connected.session.writesBlocked
      ? t('dash.linkReconnected')
      : t('dash.linkConnected'),
  );
  infoCard.body.append(dl);
  root.append(infoCard.card);

  // ── Current profile ────────────────────────────────────────────────
  const profCard = card(t('dash.profile'));
  const pdl = el('dl', 'kv');
  const light = decodeLightState(snap.profile.raw);
  const lightName = light ? (lightModeInfo(light.mode)?.name ?? `effect ${light.mode}`) : null;
  kv(pdl, t('dash.lighting'), lightName ?? '—');
  if (light) {
    kv(pdl, t('dash.speed'), String(light.speed));
    kv(pdl, t('dash.brightness'), String(light.brightness));
  }
  kv(pdl, t('dash.sleepTimer'), snap.profile.sleepSeconds !== null ? `${snap.profile.sleepSeconds} s` : '—');
  kv(pdl, t('dash.keyLayer'), `Layer ${app.layer + 1} of 4`);
  // Named game/app profiles (bead 0hl): which saved profile was last
  // applied — manual switching only, a browser page cannot detect the
  // foreground app (see the Backup & restore → Game & app profiles card).
  const sw = profileSwitcherSummary();
  kv(
    pdl,
    t('dash.savedProfile'),
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

  // ── Capability summary (spec §4 step 6 / §8): what this device can
  //    do, in plain language with reasons — not a raw capability table.
  const CAP_FEATURES: { id: FeatureId; title: string; blurb: string }[] = [
    { id: 'lighting-studio', title: t('dash.action.lighting'), blurb: t('dash.action.lightingBlurb') },
    { id: 'keymap-editor', title: t('dash.action.keys'), blurb: t('dash.action.keysBlurb') },
    { id: 'macro-studio', title: t('dash.action.macro'), blurb: t('dash.action.macroBlurb') },
    { id: 'music-reactive', title: t('dash.action.music'), blurb: t('dash.action.musicBlurb') },
    { id: 'actuation', title: t('nav.performance'), blurb: 'Hall-effect actuation & rapid trigger' },
  ];
  const capCard = card(t('dash.capabilities'));
  capCard.body.append(el('p', 'hint', t('dash.capabilitiesHint')));
  const capList = el('ul', 'cap-list');
  for (const f of CAP_FEATURES) {
    const li = el('li', 'cap-item');
    const name = el('span', 'cap-name', f.title);
    li.append(name, el('span', 'cap-blurb', describeFeature(caps, f.id)));
    capList.append(li);
  }
  capCard.body.append(capList);
  root.append(capCard.card);

  // ── Quick actions ──────────────────────────────────────────────────
  // Only features the connected device supports get a shortcut
  // (UIUX-SPEC §3: capability-driven UI). "Ask AI" is a contextual
  // entry point (spec §3), not a nav destination; "Back up settings"
  // nudges the pre-write backup habit (spec §4 step 8).
  const actions: { path: string; title: string; blurb: string; feature?: FeatureId }[] = [
    { path: '/lighting', title: t('dash.action.lighting'), blurb: t('dash.action.lightingBlurb'), feature: 'lighting-studio' },
    { path: '/keys', title: t('dash.action.keys'), blurb: t('dash.action.keysBlurb'), feature: 'keymap-editor' },
    { path: '/macro', title: t('dash.action.macro'), blurb: t('dash.action.macroBlurb'), feature: 'macro-studio' },
    { path: '/advanced', title: t('dash.action.advanced'), blurb: t('dash.action.advancedBlurb'), feature: 'adv-keys' },
    { path: '/music', title: t('dash.action.music'), blurb: t('dash.action.musicBlurb'), feature: 'music-reactive' },
    { path: '/assistant', title: t('dash.action.assistant'), blurb: t('dash.action.assistantBlurb') },
    { path: '/config', title: t('dash.action.backup'), blurb: t('dash.action.backupBlurb') },
    { path: '/device', title: t('dash.action.device'), blurb: t('dash.action.deviceBlurb') },
  ];
  const qaCard = card(t('dash.quickActions'));
  const grid = el('div', 'dash-actions');
  for (const a of actions) {
    if (a.feature && !isFeatureAvailable(caps, a.feature)) continue;
    const link = el('a', 'dash-action');
    link.href = `#${a.path}`;
    link.append(el('span', 'dash-action-title', a.title), el('span', 'dash-action-blurb', a.blurb));
    grid.append(link);
  }
  qaCard.body.append(grid);
  // Backup nudge (spec §4 step 8): shown until the browser holds at
  // least one restore point — either a pre-write SnapshotStore backup
  // (section restore) or a ProfileHistory entry (named/auto-captured
  // full-state snapshot). Both stores are localStorage-backed.
  let hasBackup = false;
  try {
    hasBackup =
      new SnapshotStore().list().length > 0 || new ProfileHistory().list().length > 0;
  } catch {
    hasBackup = false;
  }
  if (!hasBackup) {
    const nudge = el('p', 'hint backup-nudge', t('dash.backupNudge'));
    const nudgeLink = el('a', '', t('dash.backupNudgeLink'));
    nudgeLink.href = '#/config';
    nudge.append(document.createTextNode(' '), nudgeLink);
    qaCard.body.append(nudge);
  }
  const disconnectBtn = el('button', 'danger', t('shell.disconnect'));
  disconnectBtn.type = 'button';
  disconnectBtn.addEventListener('click', () => void disconnect());
  qaCard.body.append(disconnectBtn);
  root.append(qaCard.card);

  // ── Health strip ───────────────────────────────────────────────────
  const healthCard = card(t('dash.health'));
  const hdl = el('dl', 'kv');
  const avail = summary.counts.supported + summary.counts.experimental + summary.counts.unverified;
  kv(hdl, t('dash.featuresAvailable'), `${avail} of ${CAPABILITY_KEYS.length}`);
  kv(hdl, t('dash.notSupported'), String(summary.counts['unsupported-hardware'] + summary.counts['unsupported-firmware']));
  kv(hdl, t('dash.unverified'), String(summary.counts.unverified + summary.counts.experimental));
  healthCard.body.append(hdl);
  const warnings: string[] = [];
  if (app.reconnectedSilently || app.connected.session.writesBlocked) {
    warnings.push(t('dash.readOnlyWarning'));
  }
  warnings.push(...summary.caveats.map((c) => `Unverified: ${c}.`));
  if (
    fnDocConn === app.connected &&
    fnDocReport &&
    !fnDocReport.intact
  ) {
    warnings.push(
      `${t('dash.fnWarning')}: ${fnDocReport.summary} — see Diagnostics for the full report.`,
    );
  }
  if (warnings.length === 0) {
    healthCard.body.append(el('p', 'hint ok', t('dash.noWarnings')));
  } else {
    const ul = el('ul', 'dash-warnings');
    for (const w of warnings) ul.append(el('li', '', w));
    healthCard.body.append(ul);
  }
  root.append(healthCard.card);

  // ── Recent changes (audit-log tail; empty is normal — the executor
  //    only writes here once transactions are wired to a sink) ────────
  const recentCard = card(t('dash.recentChanges'));
  let entries: ReturnType<AuditLog['tail']> = [];
  try {
    entries = new AuditLog().tail(8);
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    recentCard.body.append(el('p', 'hint', t('dash.noChanges')));
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
      // Status vocabulary (ui/status.ts): the raw audit result is
      // normalised onto verified / applied-unverified / partial /
      // unsupported / unverified / failed — never colour-only.
      const tag = statusTag(statusKindFor(e.result));
      const chip = el('span', tag.className, t(tag.labelKey));
      const li = el('li', 'dash-audit-item');
      li.append(
        document.createTextNode(`${when} — ${e.op} `),
        chip,
        document.createTextNode(`${e.detail ? `: ${e.detail}` : ''}`),
      );
      ul.append(li);
    }
    recentCard.body.append(ul);
  }
  root.append(recentCard.card);
}
