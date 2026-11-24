/**
 * Page renderers for the khub916 configurator shell.
 *
 * Route map mirrors the vendor 1khub menu order subset we ship:
 *   home · lighting · keys · macro · advanced · device
 * (vendor: lightingEffect, basicChangeKeyCode, macroConfiguration,
 *  advancedKey, basicFunctions, deviceOverview, … — see
 *  docs/web-ui-plan.md §2).
 */

import { app, subscribe, type KeyEntry } from './state.ts';
import { renderLightingPage, destroyLightingPage } from './lighting.ts';
import { MacroPage } from './macro.ts';
import { AdvPage } from './advkeys.ts';
import { renderKeysPage, destroyKeysPage } from './remap.ts';
import { SECONDARY_PAGES, SECONDARY_RENDERERS, snapshotToJson } from './pages-secondary.ts';
import { formatVidPid } from './hid.ts';

export type PageId =
  | 'lighting'
  | 'keys'
  | 'macro'
  | 'advanced'
  | 'device'
  | 'basic'
  | 'config'
  | 'rhythm'
  | 'setting';

/**
 * Full route table — every hash route keeps working (deep links),
 * including the rarely-used secondary pages. `NAV_PAGES` below is the
 * slim sidebar subset; secondary pages are reached from the Device page.
 */
export const PAGES: readonly { id: PageId; path: string; title: string }[] = [
  { id: 'lighting', path: '/lighting', title: 'Lighting' },
  { id: 'keys', path: '/keys', title: 'Keys' },
  { id: 'macro', path: '/macro', title: 'Macro' },
  { id: 'advanced', path: '/advanced', title: 'Advanced' },
  { id: 'device', path: '/device', title: 'Device' },
  // Secondary pages (bead jwb): vendor basicFunctions / configurationManagement
  // / rhythm / setting — implemented in pages-secondary.ts.
  ...SECONDARY_PAGES,
] as const;

/** Sidebar shows at most these five — plain labels, no jargon. */
export const NAV_PAGES: readonly { id: PageId; path: string; title: string }[] = [
  { id: 'lighting', path: '/lighting', title: 'Lighting' },
  { id: 'keys', path: '/keys', title: 'Keys' },
  { id: 'macro', path: '/macro', title: 'Macro' },
  { id: 'advanced', path: '/advanced', title: 'Advanced' },
  { id: 'device', path: '/device', title: 'Device' },
];

/** Which sidebar item should look active for a given route. */
export function navIdFor(page: PageId): PageId {
  // Rarely-used pages live under Device in the mental model.
  return page === 'basic' || page === 'config' || page === 'rhythm' || page === 'setting'
    ? 'device'
    : page;
}

export function pageFromHash(hash: string): PageId {
  const p = hash.replace(/^#\/?/, '');
  // The old `#/home` route (and anything unknown) lands on Lighting —
  // the keyboard visualizer IS the home screen now.
  return (PAGES.find((pg) => pg.path === `/${p}`)?.id ?? 'lighting') as PageId;
}

// ── DOM helpers ────────────────────────────────────────────────────────

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

function comingSoon(title: string, blurb: string, facts: string[] = []): HTMLElement {
  const { card: c, body } = card(title);
  body.append(el('p', 'coming-soon', 'Coming soon — read-only preview.'));
  body.append(el('p', 'hint', blurb));
  if (facts.length) {
    const ul = el('ul', 'fact-list');
    for (const f of facts) ul.append(el('li', '', f));
    body.append(ul);
  }
  return c;
}

// ── Keys (keyboard visualizer k00 + remap page 28d → remap.ts) ────────

function renderKeys(root: HTMLElement): void {
  renderKeysPage(root);
}

// ── Device (overview + raw regions) ────────────────────────────────────

function renderDevice(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    root.append(
      comingSoon(
        'Device',
        'Press the Connect button at the top right to see your keyboard\'s ' +
          'model, firmware version and battery level.',
      ),
    );
    return;
  }
  const snap = app.snapshot;

  const infoCard = card('About your keyboard');
  const dl = el('dl', 'kv');
  kv(dl, 'Model', snap.info.catalogName ?? 'Unknown model');
  kv(dl, 'Firmware', snap.info.versionHex);
  kv(dl, 'Battery', `${snap.power.percent}%`);
  kv(
    dl,
    'Screen',
    snap.info.screen ? `${snap.info.screen[0]}×${snap.info.screen[1]}` : 'None',
  );
  infoCard.body.append(dl);
  root.append(infoCard.card);

  // Rarely-used pages live here instead of the sidebar.
  const more = card('More options');
  const moreLinks = el('div', 'home-links');
  for (const [path, label] of [
    ['/setting', 'Sleep timer'],
    ['/config', 'Backup & restore'],
    ['/basic', 'Keyboard layout info'],
    ['/rhythm', 'Music-reactive lighting'],
  ] as const) {
    const a = el('a', '', label);
    a.href = `#${path}`;
    moreLinks.append(a);
  }
  more.body.append(moreLinks);
  root.append(more.card);

  // Everything below is diagnostic detail — collapsed by default.
  const adv = el('details', 'advanced');
  adv.append(el('summary', '', 'Technical details'));
  const body = el('div', 'advanced-body');

  const rawCard = el('section', 'card');
  rawCard.style.marginBottom = '0';
  rawCard.append(el('h2', '', 'Connection details'));
  const rawDl = el('dl', 'kv');
  kv(rawDl, 'Model id', snap.info.catalogModel ?? '—');
  kv(rawDl, 'Device ID', snap.info.uuid);
  kv(rawDl, 'Stored settings', `${snap.profile.raw.length} bytes`);
  kv(
    rawDl,
    'Lighting mode',
    snap.profile.lightMode !== null ? `0x${snap.profile.lightMode.toString(16).padStart(4, '0')}` : '—',
  );
  kv(
    rawDl,
    'Sleep time',
    snap.profile.sleepSeconds !== null ? `${snap.profile.sleepSeconds} s` : '—',
  );
  kv(rawDl, 'Lighting data', `${snap.lightData.length} bytes`);
  kv(rawDl, 'Macro data', `${snap.macro.length} bytes`);
  kv(dl, 'Connection', `${formatVidPid(app.connected!.device)} · ${app.connected!.device.productName ?? app.connected!.device.manufacturerName ?? ''}`);
  rawCard.append(rawDl);
  body.append(rawCard);

  const lightCard = el('section', 'card');
  lightCard.style.marginBottom = '0';
  lightCard.append(el('h2', '', 'Per-key colours'));
  const grid = el('div', 'lightgrid');
  for (const col of snap.colors) {
    const sw = el('div', 'swatch');
    sw.style.background = `rgb(${col.r},${col.g},${col.b})`;
    sw.title = `Key ${col.index} — rgb(${col.r},${col.g},${col.b})`;
    grid.append(sw);
  }
  lightCard.append(grid);
  body.append(lightCard);

  const kmCard = el('section', 'card');
  kmCard.style.marginBottom = '0';
  kmCard.append(el('h2', '', `Key assignments — key set ${app.layer + 1}`));
  kmCard.append(el('p', 'hint', 'Every key position, in order.'));
  const kgrid = el('div', 'keygrid');
  const entries = snap.keymaps.get(app.layer) ?? [];
  entries.forEach((k: KeyEntry, i: number) => {
    const cell = el('div', 'key');
    cell.title = `Key ${i} — ${k.label || 'unnamed'}`;
    cell.append(el('span', 'key-label', k.label || '·'), el('span', 'key-idx', String(i)));
    kgrid.append(cell);
  });
  kmCard.append(kgrid);
  body.append(kmCard);

  const jsonCard = el('section', 'card');
  jsonCard.style.marginBottom = '0';
  jsonCard.append(el('h2', '', 'All data as JSON'));
  jsonCard.append(el('p', 'hint', 'Everything the app can read from the keyboard, as one file — for backups and the omg CLI.'));
  const pre = el('pre', 'sec-log sec-json');
  pre.textContent = snapshotToJson(snap);
  jsonCard.append(pre);
  body.append(jsonCard);

  adv.append(body);
  root.append(adv);
}

// ── Placeholder pages ──────────────────────────────────────────────────

// ── Lighting (bead far — full page in lighting.ts) ────────────────────

function renderLighting(root: HTMLElement): void {
  renderLightingPage(root);
}

// ── Macro (bead ae3) ───────────────────────────────────────────────────
//
// The MacroPage is stateful (draft steps, selection, bind form), so it is
// created once per mount and updates itself via `subscribe` — unlike the
// stateless placeholder renderers it must NOT be rebuilt on every emit.
// `isConnected` detects navigation away (another renderer's
// `replaceChildren` detaches it) so returning to the route remounts.

let macroPage: MacroPage | null = null;

function renderMacro(root: HTMLElement): void {
  if (macroPage && macroPage.el.isConnected) return;
  macroPage?.destroy();
  macroPage = new MacroPage(root);
}

// ── Advanced keys (bead 0um) ──────────────────────────────────────────
//
// Stateful like MacroPage: created once per mount, subscribes itself,
// destroyed on navigation away (`isConnected` check + route() teardown).

let advPage: AdvPage | null = null;

function renderAdvanced(root: HTMLElement): void {
  if (advPage && advPage.el.isConnected) return;
  advPage?.destroy();
  advPage = new AdvPage(root);
}

// ── Router ─────────────────────────────────────────────────────────────

const renderers: Record<PageId, (root: HTMLElement) => void> = {
  lighting: renderLighting,
  keys: renderKeys,
  macro: renderMacro,
  advanced: renderAdvanced,
  device: renderDevice,
  ...SECONDARY_RENDERERS,
};

let currentPage: PageId | null = null;
let pageRoot: HTMLElement | null = null;
let navEl: HTMLElement | null = null;
let unsub: (() => void) | null = null;

export function initPages(root: HTMLElement, nav: HTMLElement): void {
  pageRoot = root;
  navEl = nav;
  unsub = subscribe(() => {
    // Re-render the visible page on every state change.
    if (currentPage) renderers[currentPage](root);
    updateNav();
  });
  window.addEventListener('hashchange', route);
  route();
}

export function destroyPages(): void {
  unsub?.();
  unsub = null;
  destroyKeysPage();
  destroyLightingPage();
  macroPage?.destroy();
  macroPage = null;
  advPage?.destroy();
  advPage = null;
  window.removeEventListener('hashchange', route);
}

function updateNav(): void {
  if (!navEl) return;
  const navPage = navIdFor(pageFromHash(location.hash));
  navEl.querySelectorAll<HTMLElement>('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === navPage);
  });
}

function route(): void {
  const page = pageFromHash(location.hash);
  // Canonical URL: the keyboard visualizer is the home screen, so empty,
  // `#/home` and unknown hashes all land on `#/lighting`.
  if (page === 'lighting' && location.hash !== '#/lighting') {
    history.replaceState(null, '', '#/lighting');
  }
  currentPage = page;
  // The macro/advanced views are stateful — tear them down when
  // navigating away so they do not keep a live subscription while
  // detached.
  if (page !== 'macro' && macroPage) {
    macroPage.destroy();
    macroPage = null;
  }
  if (page !== 'advanced' && advPage) {
    advPage.destroy();
    advPage = null;
  }
  if (pageRoot) renderers[page](pageRoot);
  updateNav();
}
