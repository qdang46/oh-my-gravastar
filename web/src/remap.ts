/**
 * Keys remap page — clone of the vendor `BasicChangeKeyCode` page
 * (docs/research/khub-webapp/BasicChangeKeyCode-BSkx5gVB.js +
 * KeyCode-C-iQBa5f.js + the `Ca[]` pool table in index-M8-m9qFR.deob.js).
 *
 * Vendor flow: click a key on the keyboard visual → the bottom "pool" of
 * assignable key values → click a pool entry → the key is rebound.
 * Differences for this build:
 * - assignments are staged as pending edits (dirty outline + label swap)
 *   and only sent after an explicit Apply + confirm dialog — the web UI
 *   has no `--yes` flag, so the confirm IS the opt-in (plan §2 spirit);
 * - writes are whole-table read-modify-write through
 *   `Khub916Session.writeKeymap` (cmd 3, tags 248/1, 512-byte payload,
 *   `5A A5` marker, cmd-131 read-back verify) — the same path as
 *   `omg kb916 set key|keymap --yes`;
 * - the vendor Win/Mac `modelList` selector and macro-binding tab are
 *   out of scope (system bit stays 0; macro binding is bead ae3's UI).
 */

import { app, ensureKeymap, setLayer, setStatus, subscribe, type KeyEntry } from './state.ts';
import {
  K1_PRO_BLOCKS,
  K1_PRO_LAYOUT_MODELS,
  keyIndexOf,
  type KeyBlock,
} from './k1pro-layout.ts';
import { KeyboardView } from './keyboard.ts';
import { decodeKeyValue, keyValueLabel, keyValueLabelOf } from './proto/khub916.ts';
import {
  KEY_POOL,
  POOL_GROUPS,
  POOL_UNASSIGN,
  poolNameFor,
  type PoolEntry,
  type PoolGroup,
} from './keypool.ts';
import './remap.css';

/** Layout for the connected model (same rule as pages.ts `blocksForModel`). */
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

// ── Page state (module-level: survives the per-emit page rebuilds) ─────

/** Pending (unsaved) remaps per layer arg → slot index → new u32 value. */
const pendingByLayer = new Map<number, Map<number, number>>();
/** Currently selected keymap slot (picker target), null = none. */
let selected: number | null = null;
/** Active pool tab + search query (persist across rebuilds). */
let activeTab: PoolGroup = 'basic';
let query = '';
let searchHadFocus = false;
/** True while a write is in flight (buttons disabled). */
let busy = false;

let keysView: KeyboardView | null = null;
let keysUnsub: (() => void) | null = null;
/** Set by renderKeysPage; invoked by module-level mutators. */
let syncPage: (() => void) | null = null;

function sync(): void {
  syncPage?.();
}

function pendingFor(layer: number): Map<number, number> {
  let m = pendingByLayer.get(layer);
  if (!m) {
    m = new Map();
    pendingByLayer.set(layer, m);
  }
  return m;
}

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

function hex8(v: number): string {
  return `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function labelOfValue(v: number): string {
  // Decoded label first; exotic dual encodings the decoder can't name
  // (e.g. `0x80700`) fall back to the vendor pool name.
  return keyValueLabelOf(v) || poolNameFor(v) || '';
}

// ── Value resolution ───────────────────────────────────────────────────

/** Committed (device-read) value for a slot, 0 when unknown/empty. */
function committedValue(layer: number, index: number): number {
  return app.snapshot?.keymaps.get(layer)?.[index]?.value ?? 0;
}

/** Effective value = pending override else committed. */
function effectiveValue(layer: number, index: number): number {
  return pendingByLayer.get(layer)?.get(index) ?? committedValue(layer, index);
}

/** Key index → physical block name for warnings/dialogs ('' when unnamed). */
function blockNameFor(blocks: readonly KeyBlock[], index: number): string {
  for (const b of blocks) {
    if (b.display && keyIndexOf(b.pos) === index) return b.name || '';
  }
  return '';
}

// ── Assign / revert ────────────────────────────────────────────────────

/**
 * Stage (or revert) one slot's value. Picking the committed value again
 * removes the pending entry; picking the pending value is a no-op.
 */
function assignValue(index: number, value: number): void {
  if (busy || index < 0 || index >= 128) return;
  const layer = app.layer;
  const committed = committedValue(layer, index);
  const m = pendingFor(layer);
  if (value === committed) {
    m.delete(index);
  } else {
    m.set(index, value >>> 0);
  }
  if (m.size === 0) pendingByLayer.delete(layer);
  sync();
}

/** Other slots in this layer already effectively bound to `value`. */
function duplicateSlots(layer: number, index: number, value: number): number[] {
  if (value === 0) return [];
  const out: number[] = [];
  const committed = app.snapshot?.keymaps.get(layer) ?? [];
  const pending = pendingByLayer.get(layer);
  const seen = new Set<number>([...committed.keys()]);
  for (const i of pending?.keys() ?? []) seen.add(i);
  for (const i of seen) {
    if (i === index) continue;
    if (effectiveValue(layer, i) === value) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

// ── Write path ─────────────────────────────────────────────────────────

interface PendingChange {
  index: number;
  oldValue: number;
  newValue: number;
}

function describeChange(c: PendingChange, blocks: readonly KeyBlock[]): string {
  const name = blockNameFor(blocks, c.index);
  return `Key ${c.index}${name ? ` (${name})` : ''}: ${labelOfValue(c.oldValue) || 'nothing'} → ${labelOfValue(c.newValue) || 'nothing'}`;
}

/**
 * Confirm dialog — the web equivalent of the CLI's `--yes` gate. Returns
 * true only when the user explicitly confirms the listed changes.
 */
function confirmWrite(title: string, lines: string[], confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.append(el('h3', 'modal-title', title));
    const ul = el('ul', 'modal-list');
    for (const line of lines) ul.append(el('li', '', line));
    modal.append(ul);
    modal.append(
      el('p', 'hint warn', 'This sends the change to the keyboard and checks it was saved.'),
    );
    const row = el('div', 'modal-actions');
    const cancel = el('button', 'btn', 'Cancel');
    const ok = el('button', 'btn btn-primary', confirmLabel);
    cancel.type = 'button';
    ok.type = 'button';
    const done = (v: boolean): void => {
      overlay.remove();
      resolve(v);
    };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) done(false);
    });
    row.append(cancel, ok);
    modal.append(row);
    overlay.append(modal);
    document.body.append(overlay);
    ok.focus();
  });
}

/**
 * Read-modify-write `changes` into the current layer's keymap and verify.
 * Only the listed slots are taken from pending — other pending edits stay
 * staged. On success the snapshot cache is refreshed with the sent values
 * (the session already verified them by read-back).
 */
async function writeChanges(changes: ReadonlyMap<number, number>): Promise<void> {
  if (busy || changes.size === 0 || !app.connected || !app.snapshot) return;
  const layer = app.layer;
  const session = app.connected.session;
  busy = true;
  sync();
  try {
    await ensureKeymap(layer);
    const entries = app.snapshot?.keymaps.get(layer) ?? [];
    const values = entries.map((e) => e.value);
    for (const [index, v] of changes) {
      while (values.length <= index) values.push(0);
      values[index] = v >>> 0;
    }
    await session.writeKeymap(layer, 0, values);
    const decoded: KeyEntry[] = values.map((v) => {
      const kv = decodeKeyValue(v);
      return { value: v, kv, label: keyValueLabel(kv) };
    });
    app.snapshot?.keymaps.set(layer, decoded);
    const m = pendingByLayer.get(layer);
    if (m) {
      for (const index of changes.keys()) m.delete(index);
      if (m.size === 0) pendingByLayer.delete(layer);
    }
    setStatus(
      `Saved ${changes.size} key change(s) — checked on the keyboard.`,
    );
  } catch (e) {
    setStatus(`Could not save the key changes: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    busy = false;
    sync();
  }
}

async function applyAll(): Promise<void> {
  const layer = app.layer;
  const m = pendingByLayer.get(layer);
  if (!m || m.size === 0 || busy) return;
  const { blocks } = blocksForModel();
  const changes: PendingChange[] = [...m.entries()].map(([index, newValue]) => ({
    index,
    oldValue: committedValue(layer, index),
    newValue,
  }));
  const ok = await confirmWrite(
    `Save ${changes.length} key change(s)?`,
    changes.map((c) => describeChange(c, blocks)),
    'Save to keyboard',
  );
  if (ok) await writeChanges(m);
}

async function applyOne(index: number): Promise<void> {
  const layer = app.layer;
  const newValue = pendingByLayer.get(layer)?.get(index);
  if (newValue === undefined || busy) return;
  const { blocks } = blocksForModel();
  const c: PendingChange = { index, oldValue: committedValue(layer, index), newValue };
  const ok = await confirmWrite(
    `Change key ${index}${blockNameFor(blocks, index) ? ` (${blockNameFor(blocks, index)})` : ''}?`,
    [describeChange(c, blocks)],
    'Save to keyboard',
  );
  if (ok) await writeChanges(new Map([[index, newValue]]));
}

function discardAll(): void {
  pendingByLayer.delete(app.layer);
  sync();
}

// ── Picker pool ────────────────────────────────────────────────────────

function filteredPool(): PoolEntry[] {
  const q = query.trim().toLowerCase();
  const items = KEY_POOL.filter((e) => e.group === activeTab);
  if (!q) return items;
  return items.filter(
    (e) => e.name.toLowerCase().includes(q) || hex8(e.value).toLowerCase().includes(q),
  );
}

// ── Page render ────────────────────────────────────────────────────────

export function renderKeysPage(root: HTMLElement): void {
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
  keysUnsub = null;
  root.replaceChildren();

  if (!app.connected || !app.snapshot) {
    const { card: c, body } = card('Your keyboard');
    body.append(
      el(
        'p',
        'hint',
        'The keyboard visualizer and key remapping need a connected keyboard. ' +
          'Click a key, pick what it should do, then save.',
      ),
    );
    root.append(c);
    return;
  }

  const { blocks, note } = blocksForModel();
  const blockByIndex = new Map<number, KeyBlock>();
  for (const b of blocks) {
    if (b.display) blockByIndex.set(keyIndexOf(b.pos), b);
  }

  // ── Keyboard card ──────────────────────────────────────────────────
  const { card: kc, body: kbody } = card('Your keyboard');

  const toolbar = el('div', 'segment-bar remap-toolbar');
  const layerBar = el('div', 'segment-bar');
  for (let layer = 0; layer < 4; layer++) {
    const b = el('button', `segment-item${app.layer === layer ? ' active' : ''}`, `Layer ${layer}`);
    b.type = 'button';
    b.addEventListener('click', () => void setLayer(layer));
    layerBar.append(b);
  }
  toolbar.append(layerBar);

  const pendingBadge = el('span', 'chip remap-pending', '');
  const applyBtn = el('button', 'btn btn-primary remap-apply', 'Save');
  applyBtn.type = 'button';
  const discardBtn = el('button', 'btn remap-discard', 'Discard');
  discardBtn.type = 'button';
  toolbar.append(pendingBadge, applyBtn, discardBtn);
  kbody.append(toolbar);
  if (note) kbody.append(el('p', 'hint warn', note));

  const holder = el('div', 'kb-holder');
  kbody.append(holder);
  keysView = new KeyboardView(holder, blocks, {
    onKeyClick: (n) => {
      selected = n;
      sync();
    },
  });

  // ── Pool card (vendor bottom "codeList") ───────────────────────────
  const { card: pc, body: pbody } = card('Pick a new function');

  const poolToolbar = el('div', 'pool-toolbar');
  const tabs = el('div', 'pool-tabs segment-bar');
  for (const g of POOL_GROUPS) {
    const b = el('button', `segment-item pool-tab${activeTab === g.id ? ' active' : ''}`, g.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      activeTab = g.id;
      sync();
    });
    tabs.append(b);
  }
  poolToolbar.append(tabs);

  const right = el('div', 'pool-toolbar-right');
  const unassignBtn = el('button', 'btn remap-unassign', 'Do nothing');
  unassignBtn.type = 'button';
  unassignBtn.title = 'Make the selected key do nothing when pressed';
  unassignBtn.addEventListener('click', () => {
    if (selected !== null) assignValue(selected, POOL_UNASSIGN.value);
  });
  const applyOneBtn = el('button', 'btn remap-apply-one', 'Save this key');
  applyOneBtn.type = 'button';
  applyOneBtn.addEventListener('click', () => {
    if (selected !== null) void applyOne(selected);
  });
  right.append(unassignBtn, applyOneBtn);
  poolToolbar.append(right);
  pbody.append(poolToolbar);

  const searchRow = el('div', 'pool-search-row');
  const search = el('input', 'pool-search-input');
  search.type = 'search';
  search.placeholder = 'Search keys…';
  search.value = query;
  search.addEventListener('input', () => {
    query = search.value;
    renderPoolItems();
  });
  search.addEventListener('focus', () => {
    searchHadFocus = true;
  });
  search.addEventListener('blur', () => {
    searchHadFocus = false;
  });
  searchRow.append(search);
  pbody.append(searchRow);

  const selInfo = el('div', 'pool-selected', '');
  pbody.append(selInfo);

  const dupWarn = el('div', 'pool-dupwarn', '');
  pbody.append(dupWarn);

  const grid = el('div', 'pool-grid');
  pbody.append(grid);

  root.append(kc, pc);

  // ── Wiring that needs the assembled DOM ────────────────────────────

  const renderPoolItems = (): void => {
    grid.replaceChildren();
    const layer = app.layer;
    for (const entry of filteredPool()) {
      const item = el('button', 'pool-item', '');
      item.type = 'button';
      const name = el('span', 'pool-item-name', entry.name);
      item.append(name);
      item.title = hex8(entry.value);
      if (selected !== null && entry.value === effectiveValue(layer, selected)) {
        item.classList.add('pool-item--current');
      }
      item.addEventListener('click', () => {
        if (selected !== null) assignValue(selected, entry.value);
      });
      grid.append(item);
    }
    if (grid.childElementCount === 0) {
      grid.append(el('p', 'hint', 'No keys match the search.'));
    }
  };

  syncPage = (): void => {
    const snap = app.snapshot;
    const layer = app.layer;
    const pending = pendingByLayer.get(layer) ?? null;

    keysView?.setData({
      keymap: snap?.keymaps.get(layer) ?? null,
      colors: snap?.colors ?? null,
      pending,
      selected,
    });

    layerBar.querySelectorAll('.segment-item').forEach((b, i) => {
      b.classList.toggle('active', i === layer);
    });

    const count = pending?.size ?? 0;
    pendingBadge.textContent = count > 0 ? `${count} unsaved` : '';
    pendingBadge.hidden = count === 0;
    applyBtn.disabled = busy || count === 0;
    applyBtn.textContent = busy ? 'Saving…' : `Save${count > 0 ? ` (${count})` : ''}`;
    discardBtn.disabled = busy || count === 0;

    // Selected-key info + per-key apply.
    if (selected === null) {
      selInfo.textContent = 'Click a key on the keyboard, then pick what it should do below.';
      selInfo.className = 'pool-selected hint';
      applyOneBtn.disabled = true;
      dupWarn.textContent = '';
    } else {
      const block = blockByIndex.get(selected);
      const committed = committedValue(layer, selected);
      const pend = pending?.get(selected);
      selInfo.className = 'pool-selected';
      selInfo.textContent =
        `Key ${selected} (${block?.name || 'unnamed'}) — ` +
        `currently ${labelOfValue(committed) || 'nothing'}` +
        (pend !== undefined
          ? `, will become ${labelOfValue(pend) || 'nothing'}`
          : '');
      applyOneBtn.disabled = busy || pend === undefined;

      // Duplicate-assignment warning (tester-contract spirit): the same
      // value on two keys is legal but almost always a mistake.
      if (pend !== undefined && pend !== 0) {
        const dup = duplicateSlots(layer, selected, pend);
        dupWarn.textContent =
          dup.length > 0
            ? `Note: ${labelOfValue(pend) || 'that key'} is also assigned to ${dup
                .map((i) => `key ${i}`)
                .join(', ')}.`
            : '';
      } else {
        dupWarn.textContent = '';
      }
    }
    unassignBtn.disabled = busy || selected === null;

    // Pool tabs + items.
    tabs.querySelectorAll('.pool-tab').forEach((b, i) => {
      b.classList.toggle('active', POOL_GROUPS[i]?.id === activeTab);
    });
    renderPoolItems();

    if (searchHadFocus && document.activeElement !== search) search.focus();
  };

  applyBtn.addEventListener('click', () => void applyAll());
  discardBtn.addEventListener('click', discardAll);

  syncPage();
  keysUnsub = subscribe(() => syncPage?.());
  void ensureKeymap(app.layer).catch(() => {});
}

/** Tear down the keys page (route change / unmount). */
export function destroyKeysPage(): void {
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
  keysUnsub = null;
  syncPage = null;
}
