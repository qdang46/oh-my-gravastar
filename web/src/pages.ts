/**
 * Page renderers for the khub916 configurator shell.
 *
 * Route map mirrors the vendor 1khub menu order subset we ship:
 *   home · lighting · keys · macro · advanced · device
 * (vendor: lightingEffect, basicChangeKeyCode, macroConfiguration,
 *  advancedKey, basicFunctions, deviceOverview, … — see
 *  docs/web-ui-plan.md §2).
 */

import { app, connect, subscribe, type KeyEntry } from './state.ts';
import { K1_PRO_BLOCKS, K1_PRO_LAYOUT_MODELS, type KeyBlock } from './k1pro-layout.ts';
import { renderLightingPage, destroyLightingPage } from './lighting.ts';
import { MacroPage } from './macro.ts';
import { AdvPage } from './advkeys.ts';
import { renderKeysPage, destroyKeysPage } from './remap.ts';
import { SECONDARY_PAGES, SECONDARY_RENDERERS, snapshotToJson } from './pages-secondary.ts';
import { formatVidPid } from './hid.ts';

export type PageId =
  | 'home'
  | 'lighting'
  | 'keys'
  | 'macro'
  | 'advanced'
  | 'device'
  | 'basic'
  | 'config'
  | 'rhythm'
  | 'setting';

export const PAGES: readonly { id: PageId; path: string; title: string }[] = [
  { id: 'home', path: '/home', title: 'Home' },
  { id: 'lighting', path: '/lighting', title: 'Lighting' },
  { id: 'keys', path: '/keys', title: 'Keys' },
  { id: 'macro', path: '/macro', title: 'Macro' },
  { id: 'advanced', path: '/advanced', title: 'Advanced' },
  { id: 'device', path: '/device', title: 'Device' },
  // Secondary pages (bead jwb): vendor basicFunctions / configurationManagement
  // / rhythm / setting — implemented in pages-secondary.ts.
  ...SECONDARY_PAGES,
] as const;

export function pageFromHash(hash: string): PageId {
  const p = hash.replace(/^#\/?/, '');
  return (PAGES.find((pg) => pg.path === `/${p}`)?.id ?? 'home') as PageId;
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

// ── Home ───────────────────────────────────────────────────────────────

function renderHome(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    const hero = el('div', 'home-hero');
    hero.append(el('h1', 'home-title', 'Set up your GravaStar keyboard'));
    hero.append(
      el(
        'p',
        'home-note',
        'Change key colours and effects, remap keys, record macros — all from ' +
          'your browser. Nothing is installed and nothing leaves your computer.',
      ),
    );
    const btn = el('button', 'home-connect', 'Connect keyboard');
    btn.type = 'button';
    btn.disabled = app.busy;
    btn.addEventListener('click', () => void connect());
    hero.append(btn);

    const steps = el('ol', 'home-steps');
    for (const [n, t] of [
      ['1', 'Plug the keyboard into your computer with a USB cable.'],
      ['2', 'Press "Connect keyboard" and pick it in the browser popup.'],
      ['3', 'Pick what to change on the left — colours, keys, macros.'],
    ] as const) {
      const li = el('li');
      li.append(el('span', 'num', n), el('span', '', t));
      steps.append(li);
    }
    hero.append(steps);

    const needs = el('p', 'hint');
    needs.textContent =
      'Works in Chrome or Edge on a computer (not phones or Firefox). ' +
      'Supported: GravaStar K1 / K1 Pro / K98 series over USB cable.';
    hero.append(needs);
    root.append(hero);
    return;
  }

  const snap = app.snapshot;
  const { card: c, body } = card(`Welcome back, ${snap.info.catalogName ?? 'GravaStar keyboard'}`);
  const chips = el('div', 'chip-row');
  chips.append(
    el('span', 'chip', snap.info.catalogName ?? 'Unknown model'),
    el('span', 'chip', `Firmware ${snap.info.versionHex}`),
    el('span', 'chip', `Battery ${snap.power.percent}%`),
  );
  body.append(chips);
  body.append(
    el(
      'p',
      'hint',
      'Everything you change is saved to the keyboard itself — it keeps ' +
        'working the same when you unplug it.',
    ),
  );
  const links = el('div', 'home-links');
  for (const [path, label] of [
    ['/lighting', 'Colours & effects'],
    ['/keys', 'Remap keys'],
    ['/macro', 'Macros'],
  ] as const) {
    const a = el('a', '', label);
    a.href = `#${path}`;
    links.append(a);
  }
  body.append(links);
  root.append(c);
}

// ── Keys (keyboard visualizer k00 + remap page 28d → remap.ts) ────────

export function blocksForModel(): { blocks: readonly KeyBlock[]; note: string | null } {
  const model = app.snapshot?.info.catalogModel;
  if (!model || K1_PRO_LAYOUT_MODELS.includes(model)) {
    return {
      blocks: K1_PRO_BLOCKS,
      note: model ? null : 'Model unknown — showing the K1 Pro reference layout.',
    };
  }
  return {
    blocks: K1_PRO_BLOCKS,
    note: `Layout table for ${model} is not ported yet — showing the K1 Pro reference layout.`,
  };
}

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
        'Connect your keyboard to see its model, firmware version and battery level.',
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

  // Everything below is diagnostic detail — collapsed by default.
  const adv = el('details', 'advanced');
  adv.append(el('summary', '', 'Technical details'));
  const body = el('div', 'advanced-body');

  const rawCard = el('section', 'card');
  rawCard.style.marginBottom = '0';
  rawCard.append(el('h2', '', 'Raw device data'));
  const rawDl = el('dl', 'kv');
  kv(rawDl, 'Model id', snap.info.catalogModel ?? '—');
  kv(rawDl, 'Device UUID', snap.info.uuid);
  kv(rawDl, 'Profile data', `${snap.profile.raw.length} bytes`);
  kv(
    rawDl,
    'Light mode',
    snap.profile.lightMode !== null ? `0x${snap.profile.lightMode.toString(16).padStart(4, '0')}` : '—',
  );
  kv(
    rawDl,
    'Sleep time',
    snap.profile.sleepSeconds !== null ? `${snap.profile.sleepSeconds} s` : '—',
  );
  kv(rawDl, 'Light data', `${snap.lightData.length} bytes`);
  kv(rawDl, 'Macro data', `${snap.macro.length} bytes`);
  kv(dl, 'HID', `${formatVidPid(app.connected!.device)} · ${app.connected!.device.productName ?? app.connected!.device.manufacturerName ?? ''}`);
  rawCard.append(rawDl);
  body.append(rawCard);

  const lightCard = el('section', 'card');
  lightCard.style.marginBottom = '0';
  lightCard.append(el('h2', '', 'Custom light colours'));
  const grid = el('div', 'lightgrid');
  for (const col of snap.colors) {
    const sw = el('div', 'swatch');
    sw.style.background = `rgb(${col.r},${col.g},${col.b})`;
    sw.title = `Slot ${col.index} — rgb(${col.r},${col.g},${col.b})`;
    grid.append(sw);
  }
  lightCard.append(grid);
  body.append(lightCard);

  const kmCard = el('section', 'card');
  kmCard.style.marginBottom = '0';
  kmCard.append(el('h2', '', `Key assignments — layer ${app.layer} (raw)`));
  kmCard.append(el('p', 'hint', 'All 128 key slots, in order.'));
  const kgrid = el('div', 'keygrid');
  const entries = snap.keymaps.get(app.layer) ?? [];
  entries.forEach((k: KeyEntry, i: number) => {
    const cell = el('div', 'key');
    cell.title = `Slot ${i} — 0x${k.value.toString(16).toUpperCase().padStart(8, '0')}`;
    cell.append(el('span', 'key-label', k.label || '·'), el('span', 'key-idx', String(i)));
    kgrid.append(cell);
  });
  kmCard.append(kgrid);
  body.append(kmCard);

  const jsonCard = el('section', 'card');
  jsonCard.style.marginBottom = '0';
  jsonCard.append(el('h2', '', 'Snapshot JSON'));
  jsonCard.append(el('p', 'hint', 'Everything readable today, as one JSON document.'));
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
  home: renderHome,
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
  const page = pageFromHash(location.hash);
  navEl.querySelectorAll<HTMLElement>('.nav-item').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

function route(): void {
  const page = pageFromHash(location.hash);
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
