/**
 * Page renderers for the khub916 configurator shell.
 *
 * Route map mirrors the vendor 1khub menu order subset we ship:
 *   home · lighting · keys · macro · advanced · device
 * (vendor: lightingEffect, basicChangeKeyCode, macroConfiguration,
 *  advancedKey, basicFunctions, deviceOverview, … — see
 *  docs/web-ui-plan.md §2).
 */

import { app, ensureKeymap, setLayer, subscribe, type KeyEntry } from './state.ts';
import { K1_PRO_BLOCKS, K1_PRO_LAYOUT_MODELS, keyIndexOf, type KeyBlock } from './k1pro-layout.ts';
import { KeyboardView } from './keyboard.ts';
import { formatVidPid } from './hid.ts';

export type PageId = 'home' | 'lighting' | 'keys' | 'macro' | 'advanced' | 'device';

export const PAGES: readonly { id: PageId; path: string; title: string }[] = [
  { id: 'home', path: '/home', title: 'Home' },
  { id: 'lighting', path: '/lighting', title: 'Lighting' },
  { id: 'keys', path: '/keys', title: 'Keys' },
  { id: 'macro', path: '/macro', title: 'Macro' },
  { id: 'advanced', path: '/advanced', title: 'Advanced' },
  { id: 'device', path: '/device', title: 'Device' },
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
    const { card: c, body } = card('Connect your keyboard');
    body.append(
      el(
        'p',
        'hint',
        'oh-my-gravastar configures GravaStar keyboards over WebHID using the ' +
          'khub916 wired protocol — the same transport as the vendor 1khub web app. ' +
          'This build is read-only: it never writes to the keyboard.',
      ),
    );
    const ul = el('ul', 'fact-list');
    for (const t of [
      'Chrome or Edge (desktop) — WebHID is not in Firefox/Safari',
      'USB cable required; the 2.4 GHz dongle (916_wireLess) is not supported yet',
      'Supported family: GravaStar Mercury K1 / K1 Pro / K1 Lite / K98 Pro / NP',
    ]) {
      ul.append(el('li', '', t));
    }
    body.append(ul);
    root.append(c);
    return;
  }

  const snap = app.snapshot;
  const { card: c, body } = card(`Welcome, ${snap.info.catalogName ?? 'GravaStar keyboard'}`);
  const chips = el('div', 'chip-row');
  chips.append(
    el('span', 'chip', snap.info.catalogName ?? 'Unknown model'),
    el('span', 'chip', `FW ${snap.info.versionHex}`),
    el('span', 'chip', `Battery ${snap.power.percent}%`),
  );
  body.append(chips);
  body.append(
    el(
      'p',
      'hint',
      'Use the sidebar to open the keyboard visualizer, lighting, keys, macro and ' +
        'device pages. Writes arrive in later releases — everything here is a live read.',
    ),
  );
  root.append(c);
}

// ── Keys (keyboard visualizer, bead k00) ───────────────────────────────

let keysView: KeyboardView | null = null;
let keysUnsub: (() => void) | null = null;

function blocksForModel(): { blocks: readonly KeyBlock[]; note: string | null } {
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
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
  keysUnsub = null;
  root.replaceChildren();

  if (!app.connected || !app.snapshot) {
    root.append(
      comingSoon(
        'Keys',
        'The keyboard visualizer needs a connected device — it renders the live ' +
          'keymap and per-key RGB colours read over WebHID.',
      ),
    );
    return;
  }

  const { blocks, note } = blocksForModel();

  const { card: c, body } = card('Keyboard');

  // Vendor-style segment bar: layer selector (the model/system selector is
  // a later bead — the khub916 system bit is not wired into the UI yet).
  const toolbar = el('div', 'segment-bar');
  for (let layer = 0; layer < 4; layer++) {
    const b = el('button', `segment-item${app.layer === layer ? ' active' : ''}`, `Layer ${layer}`);
    b.type = 'button';
    b.addEventListener('click', () => void setLayer(layer));
    toolbar.append(b);
  }
  body.append(toolbar);
  if (note) body.append(el('p', 'hint warn', note));

  const holder = el('div', 'kb-holder');
  body.append(holder);
  keysView = new KeyboardView(holder, blocks);

  const refreshView = (): void => {
    const snap = app.snapshot;
    keysView?.setData({
      keymap: snap?.keymaps.get(app.layer) ?? null,
      colors: snap?.colors ?? null,
    });
    toolbar.querySelectorAll('.segment-item').forEach((b, i) => {
      b.classList.toggle('active', i === app.layer);
    });
  };
  refreshView();
  keysUnsub = subscribe(refreshView);
  void ensureKeymap(app.layer).catch(() => {});
  root.append(c);
}

// ── Device (overview + raw regions) ────────────────────────────────────

function renderDevice(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    root.append(
      comingSoon(
        'Device',
        'Connect a keyboard to read its identity, firmware, battery, profile ' +
          'blob, macro region and custom light colours.',
      ),
    );
    return;
  }
  const snap = app.snapshot;
  const c = app.connected;

  const infoCard = card('Device info');
  const dl = el('dl', 'kv');
  kv(dl, 'Model', snap.info.catalogName ?? 'Unknown (UUID not in catalog)');
  kv(dl, 'Model id', snap.info.catalogModel ?? '—');
  kv(dl, 'UUID', snap.info.uuid);
  kv(dl, 'Firmware', snap.info.versionHex);
  kv(
    dl,
    'Screen',
    snap.info.screen
      ? `${snap.info.screen[0]}×${snap.info.screen[1]} (code ${snap.info.screenSize})`
      : 'none',
  );
  kv(dl, 'Battery', `${snap.power.percent}% (flags 0x${snap.power.flags.toString(16).padStart(2, '0').toUpperCase()})`);
  kv(dl, 'Transport', `${c.kind} · reportId ${c.reportId} · usagePage 0x${c.collection.usagePage.toString(16).toUpperCase()}`);
  kv(dl, 'HID', `${formatVidPid(c.device)} · ${c.device.productName ?? c.device.manufacturerName ?? ''}`);
  infoCard.body.append(dl);
  root.append(infoCard.card);

  const rawCard = card('Profile / raw regions');
  const rawDl = el('dl', 'kv');
  kv(rawDl, 'Profile blob', `${snap.profile.raw.length} bytes`);
  kv(rawDl, 'Light mode', snap.profile.lightMode !== null ? `0x${snap.profile.lightMode.toString(16).padStart(4, '0')}` : '—');
  kv(rawDl, 'Sleep time', snap.profile.sleepSeconds !== null ? `${snap.profile.sleepSeconds} s` : '—');
  kv(rawDl, 'Light data (138)', `${snap.lightData.length} bytes (raw — per-mode RGB groups not decoded yet)`);
  kv(rawDl, 'Macro region (133)', `${snap.macro.length} bytes (raw — header semantics unproven, spec §6)`);
  rawCard.body.append(rawDl);
  root.append(rawCard.card);

  const lightCard = card('Custom light colours (cmd 134)');
  const grid = el('div', 'lightgrid');
  for (const col of snap.colors) {
    const sw = el('div', 'swatch');
    sw.style.background = `rgb(${col.r},${col.g},${col.b})`;
    sw.title = `#${col.index} pos=${col.pos} rgb(${col.r},${col.g},${col.b})`;
    grid.append(sw);
  }
  lightCard.body.append(grid);
  root.append(lightCard.card);

  const kmCard = card(`Keymap — layer ${app.layer} (raw)`);
  kmCard.body.append(el('p', 'hint', '128 u32 slots; index n ↔ pos 8+4n. Labels are the live decode.'));
  const kgrid = el('div', 'keygrid');
  const entries = snap.keymaps.get(app.layer) ?? [];
  entries.forEach((k: KeyEntry, i: number) => {
    const cell = el('div', 'key');
    cell.title = `#${i} = 0x${k.value.toString(16).toUpperCase().padStart(8, '0')}`;
    cell.append(el('span', 'key-label', k.label || '·'), el('span', 'key-idx', String(i)));
    kgrid.append(cell);
  });
  kmCard.body.append(kgrid);
  root.append(kmCard.card);
}

// ── Placeholder pages ──────────────────────────────────────────────────

function renderLighting(root: HTMLElement): void {
  root.replaceChildren();
  const facts: string[] = [];
  const snap = app.snapshot;
  if (snap?.profile.lightMode != null) {
    facts.push(`Current light mode: 0x${snap.profile.lightMode.toString(16).padStart(4, '0')} (from profile blob)`);
  }
  if (snap?.profile.sleepSeconds != null) facts.push(`Sleep time: ${snap.profile.sleepSeconds} s`);
  facts.push('126 per-key custom colours are readable today (shown on the Device page).');
  facts.push('Effect picker, speed/brightness sliders and custom colour writes land with the lighting bead.');
  root.append(
    comingSoon(
      'Lighting',
      'Vendor page: 灯光设置 — effect mode list, speed/brightness sliders (0–20), ' +
        'colour presets and a per-key custom colour grid.',
      facts,
    ),
  );
}

function renderMacro(root: HTMLElement): void {
  root.replaceChildren();
  const facts: string[] = [];
  if (app.snapshot) facts.push(`Macro region currently holds ${app.snapshot.macro.length} raw bytes.`);
  facts.push('Macro decode + editor arrive with the macro protocol bead (cmd 133 parse, cmd 3 write path).');
  root.append(
    comingSoon(
      'Macro',
      'Vendor page: 宏设置 — record/edit macros, bind them to keys, loop types.',
      facts,
    ),
  );
}

function renderAdvanced(root: HTMLElement): void {
  root.replaceChildren();
  root.append(
    comingSoon(
      'Advanced',
      'Vendor page: 高级键 — SOCD, MT (hold/tap) and TGL trigger configuration ' +
        'on top of the keyboard visualizer.',
      [
        'Blocked on the khub916 advanced-keys protocol bead (cmd 18 wired / cmd 82 wireless).',
        'Key values with SOCD/MT/TGL tags already decode in the keymap labels.',
      ],
    ),
  );
}

// ── Router ─────────────────────────────────────────────────────────────

const renderers: Record<PageId, (root: HTMLElement) => void> = {
  home: renderHome,
  lighting: renderLighting,
  keys: renderKeys,
  macro: renderMacro,
  advanced: renderAdvanced,
  device: renderDevice,
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
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
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
  if (pageRoot) renderers[page](pageRoot);
  updateNav();
}
