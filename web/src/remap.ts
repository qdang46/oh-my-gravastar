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
 * - staged edits live in `StagedEdits` (./remap-edit.ts): per-arg pending
 *   map + undo/redo history, layer copy/reset, all staged-only;
 * - keymap args are `layer | system<<2` (0–3 user "key sets", 4–7 the
 *   system-bit variants — spec §6); the page edits all eight via a
 *   User/System mode toggle + four layer tabs (bead c8y);
 * - the vendor Win/Mac `modelList` selector and macro-binding tab are
 *   out of scope (macro binding is bead ae3's UI).
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
import { StagedEdits } from './remap-edit.ts';
import { confirmDialog } from './modal.ts';
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

/** Currently selected keymap slot (picker target), null = none. */
let selected: number | null = null;
/** Multi-select set on the visualizer (Ctrl/Shift/Cmd+click toggles). */
const selSet = new Set<number>();
/** Set by the holder capture listener when the last click was a toggle. */
let multiToggle = false;
/** Active pool tab + search query (persist across rebuilds). */
let activeTab: PoolGroup = 'basic';
let query = '';
let searchHadFocus = false;
/** System-bit keymap variant (arg bit 2): false = user key sets 0–3. */
let systemMode = false;
/** True while a write is in flight (buttons disabled). */
let busy = false;

let keysView: KeyboardView | null = null;
let keysUnsub: (() => void) | null = null;
/** Set by renderKeysPage; invoked by module-level mutators. */
let syncPage: (() => void) | null = null;
/** Document keydown handler for Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
let undoKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Keymap arg being edited: `layer | system<<2` (spec §6). */
function currentArg(): number {
  return app.layer | (systemMode ? 4 : 0);
}

/** Human label for a keymap arg (copy pickers, dialogs, status). */
function argLabel(arg: number): string {
  return arg < 4 ? `Key set ${arg + 1}` : `System key set ${arg - 3}`;
}

function sync(): void {
  syncPage?.();
}

// ── Staged-edit store ──────────────────────────────────────────────────

/** Committed (device-read) value for a slot, 0 when unknown/empty. */
function committedValue(arg: number, index: number): number {
  return app.snapshot?.keymaps.get(arg)?.[index]?.value ?? 0;
}

const edits = new StagedEdits(committedValue);

/** Effective value = pending override else committed. */
function effectiveValue(arg: number, index: number): number {
  return edits.effective(arg, index);
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

// ── Key index → physical block name ────────────────────────────────────

/** Key index → physical block name for warnings/dialogs ('' when unnamed). */
function blockNameFor(blocks: readonly KeyBlock[], index: number): string {
  for (const b of blocks) {
    if (b.display && keyIndexOf(b.pos) === index) return b.name || '';
  }
  return '';
}

// ── Stage / revert / undo ──────────────────────────────────────────────

/**
 * Stage one value on every index in `indices` as ONE undoable edit.
 * `value === null` reverts the slots to their device-read values
 * ("reset key(s) to device value"). Picking the committed value also
 * reverts — `StagedEdits.stage` collapses it.
 */
function stageIndices(indices: Iterable<number>, value: number | null): void {
  if (busy) return;
  const arg = currentArg();
  const changes = new Map<number, number | null>();
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0 && i < 128) changes.set(i, value);
  }
  if (changes.size > 0) edits.stage(arg, changes);
  sync();
}

/** Primary index = most recently added member of the selection set. */
function primaryOf(): number | null {
  let last: number | null = null;
  for (const i of selSet) last = i;
  return last;
}

/** Stage `value` on every selected key as ONE undoable edit. */
function assignToSelection(value: number): void {
  stageIndices(selSet, value);
}

/** Other slots in this arg already effectively bound to `value`. */
function duplicateSlots(arg: number, index: number, value: number): number[] {
  if (value === 0) return [];
  const out: number[] = [];
  const committed = app.snapshot?.keymaps.get(arg) ?? [];
  const pending = edits.pendingView(arg);
  const seen = new Set<number>([...committed.keys()]);
  for (const i of pending.keys()) seen.add(i);
  for (const i of seen) {
    if (i === index) continue;
    if (effectiveValue(arg, i) === value) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

function doUndo(): void {
  if (busy || !edits.canUndo()) return;
  edits.undo();
  sync();
}

function doRedo(): void {
  if (busy || !edits.canRedo()) return;
  edits.redo();
  sync();
}

// ── Layer tools (copy / reset-to-read) ─────────────────────────────────

/**
 * Stage a copy of `src`'s effective values onto `dst` as pending edits.
 * Confirmed first — nothing is sent until the user presses Save, and the
 * staged copy is itself undoable.
 */
async function copyLayer(src: number, dst: number): Promise<void> {
  if (busy || src === dst) return;
  const plan = edits.planCopy(src, dst);
  if (!plan) return;
  if (plan.size === 0) {
    setStatus(`${argLabel(dst)} already matches ${argLabel(src)} — nothing to stage.`);
    return;
  }
  const ok = await confirmDialog({
    title: `Copy ${argLabel(src)} to ${argLabel(dst)}?`,
    details: [
      `Stage ${plan.size} key change(s) on ${argLabel(dst)} from ${argLabel(src)}.`,
      'Keys are copied as they currently appear, including unsaved edits.',
    ],
    hint: 'This only stages the copy — press Save to send it to the keyboard.',
    confirmLabel: 'Stage copy',
  });
  if (!ok || busy) return;
  const n = edits.copyLayer(src, dst);
  if (n > 0) {
    setStatus(`Staged ${n} key change(s): ${argLabel(src)} → ${argLabel(dst)}.`);
  }
  sync();
}

/** Reset one key set to its device-read values (staged, undoable). */
function resetLayerToRead(arg: number): void {
  if (busy) return;
  if (edits.clearLayer(arg)) {
    setStatus(`Reset ${argLabel(arg)} to the values read from the keyboard (unsaved until Save).`);
  } else {
    setStatus(`${argLabel(arg)} has no unsaved changes.`);
  }
  sync();
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
 * Thin wrapper over the shared modal (./modal.ts).
 */
function confirmWrite(title: string, lines: string[], confirmLabel: string): Promise<boolean> {
  return confirmDialog({
    title,
    details: lines,
    hint:
      'Only the keys listed above change — everything else stays the same. ' +
      'The keyboard checks each change was saved.',
    confirmLabel,
  });
}

/**
 * Read-modify-write `changes` into the current arg's keymap and verify.
 * Only the listed slots are taken from pending — other pending edits stay
 * staged. On success the snapshot cache is refreshed with the sent values
 * (the session already verified them by read-back) and the undo history
 * is cleared: committed values changed underneath it.
 */
async function writeChanges(changes: ReadonlyMap<number, number>): Promise<void> {
  if (busy || changes.size === 0 || !app.connected || !app.snapshot) return;
  const arg = currentArg();
  const layer = arg & 3;
  const system = (arg >> 2) & 1;
  const session = app.connected.session;
  busy = true;
  sync();
  try {
    await ensureKeymap(arg);
    const entries = app.snapshot?.keymaps.get(arg) ?? [];
    const values = entries.map((e) => e.value);
    for (const [index, v] of changes) {
      while (values.length <= index) values.push(0);
      values[index] = v >>> 0;
    }
    await session.writeKeymap(layer, system, values);
    const decoded: KeyEntry[] = values.map((v) => {
      const kv = decodeKeyValue(v);
      return { value: v, kv, label: keyValueLabel(kv) };
    });
    app.snapshot?.keymaps.set(arg, decoded);
    edits.dropWritten(arg, changes.keys());
    edits.clearHistory();
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
  const arg = currentArg();
  const pending = edits.pendingView(arg);
  if (pending.size === 0 || busy) return;
  const { blocks } = blocksForModel();
  const changes: PendingChange[] = [...pending.entries()].map(([index, newValue]) => ({
    index,
    oldValue: committedValue(arg, index),
    newValue,
  }));
  const ok = await confirmWrite(
    `Save ${changes.length} key change(s)?`,
    changes.map((c) => describeChange(c, blocks)),
    'Save to keyboard',
  );
  if (ok) await writeChanges(pending);
}

async function applyOne(index: number): Promise<void> {
  const arg = currentArg();
  const newValue = edits.pendingView(arg).get(index);
  if (newValue === undefined || busy) return;
  const { blocks } = blocksForModel();
  const c: PendingChange = { index, oldValue: committedValue(arg, index), newValue };
  const ok = await confirmWrite(
    `Change key ${index}${blockNameFor(blocks, index) ? ` (${blockNameFor(blocks, index)})` : ''}?`,
    [describeChange(c, blocks)],
    'Save to keyboard',
  );
  if (ok) await writeChanges(new Map([[index, newValue]]));
}

// ── Picker pool ────────────────────────────────────────────────────────

/** Does the pool query match this entry's name, codes or HID usage? */
function poolMatch(e: PoolEntry, q: string): boolean {
  if (e.name.toLowerCase().includes(q)) return true;
  const hex = hex8(e.value).toLowerCase();
  if (hex.includes(q)) return true;
  // Raw decimal value (vendor pool values are large; decimal search helps).
  if (e.value !== 0 && String(e.value).includes(q)) return true;
  if (e.usage !== null) {
    const u = e.usage;
    // HID usage as decimal ("4"), bare hex ("04"/"4") or 0x-prefixed hex.
    if (String(u) === q) return true;
    const uhex = u.toString(16).toLowerCase();
    if (q === uhex || q === `0x${uhex}` || q === `0x${u.toString(16).padStart(2, '0').toLowerCase()}`) {
      return true;
    }
    if (e.usageLabel && e.usageLabel.toLowerCase().includes(q)) return true;
  }
  return false;
}

function filteredPool(): PoolEntry[] {
  const q = query.trim().toLowerCase();
  const items = KEY_POOL.filter((e) => e.group === activeTab);
  if (!q) return items;
  return items.filter((e) => poolMatch(e, q));
}

// ── Page render ────────────────────────────────────────────────────────

export function renderKeysPage(root: HTMLElement): void {
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
  keysUnsub = null;
  syncPage = null;
  root.replaceChildren();

  if (!app.connected || !app.snapshot) {
    const { card: c, body } = card('Your keyboard');
    body.append(
      el(
        'p',
        'hint',
        'The keyboard visualizer and key remapping need a connected keyboard. ' +
          'Press the Connect button at the top right, then click a key, ' +
          'pick what it should do, and save.',
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

  // User / System mode toggle — the keymap arg's bit 2 (spec §6).
  const modeBar = el('div', 'segment-bar remap-mode-bar');
  const userModeBtn = el('button', `segment-item${systemMode ? '' : ' active'}`, 'User keys');
  const sysModeBtn = el('button', `segment-item${systemMode ? ' active' : ''}`, 'System keys');
  userModeBtn.type = 'button';
  sysModeBtn.type = 'button';
  userModeBtn.title = 'Edit the four user key sets (args 0–3)';
  sysModeBtn.title = 'Edit the four system-variant key sets (args 4–7)';
  userModeBtn.addEventListener('click', () => {
    if (systemMode) {
      systemMode = false;
      void ensureKeymap(currentArg()).catch(() => {});
      sync();
    }
  });
  sysModeBtn.addEventListener('click', () => {
    if (!systemMode) {
      systemMode = true;
      void ensureKeymap(currentArg()).catch(() => {});
      sync();
    }
  });
  modeBar.append(userModeBtn, sysModeBtn);

  // Layer tabs 0–3 — each edits arg `i | system<<2`, shows its own
  // dirty dot, and carries a per-tab reset-to-read button.
  const layerBar = el('div', 'segment-bar remap-layer-bar');
  const layerTabRefs: { btn: HTMLElement; dot: HTMLElement; reset: HTMLButtonElement }[] = [];
  for (let layer = 0; layer < 4; layer++) {
    const wrap = el('span', 'layer-tab');
    const b = el(
      'button',
      `segment-item${app.layer === layer ? ' active' : ''}`,
      `Key set ${layer + 1}`,
    );
    b.type = 'button';
    const dot = el('span', 'remap-tab-dot');
    dot.hidden = true;
    b.append(dot);
    const reset = el('button', 'layer-tab-reset', '↺');
    reset.type = 'button';
    reset.title = `Reset ${argLabel(layer | (systemMode ? 4 : 0))} to the values read from the keyboard (staged)`;
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      resetLayerToRead(layer | (systemMode ? 4 : 0));
    });
    wrap.append(b, reset);
    layerTabRefs.push({ btn: b, dot, reset });
    b.addEventListener('click', () => {
      void setLayer(layer).then(() => ensureKeymap(currentArg()).catch(() => {}));
    });
    layerBar.append(wrap);
  }
  toolbar.append(modeBar, layerBar);

  const pendingBadge = el('span', 'chip remap-pending', '');
  const applyBtn = el('button', 'btn btn-primary remap-apply', 'Save');
  applyBtn.type = 'button';
  const discardBtn = el('button', 'btn remap-discard', 'Discard');
  discardBtn.type = 'button';
  discardBtn.title = 'Drop all unsaved changes on this key set (undoable)';
  toolbar.append(pendingBadge, applyBtn, discardBtn);
  kbody.append(toolbar);
  if (note) kbody.append(el('p', 'hint warn', note));

  // ── Staged-edit tools: undo/redo + layer copy ──────────────────────
  const tools = el('div', 'remap-tools');

  const undoBtn = el('button', 'btn remap-undo', '↶ Undo');
  undoBtn.type = 'button';
  undoBtn.title = 'Undo the last staged key change (Ctrl+Z)';
  undoBtn.addEventListener('click', doUndo);
  const redoBtn = el('button', 'btn remap-redo', '↷ Redo');
  redoBtn.type = 'button';
  redoBtn.title = 'Redo the last undone change (Ctrl+Shift+Z or Ctrl+Y)';
  redoBtn.addEventListener('click', doRedo);
  tools.append(undoBtn, redoBtn);

  const copyLabel = el('span', 'hint remap-copy-label', 'Copy key set:');
  const srcSel = el('select', 'remap-copy-select') as HTMLSelectElement;
  const dstSel = el('select', 'remap-copy-select') as HTMLSelectElement;
  for (let arg = 0; arg < 8; arg++) {
    const so = el('option', '', argLabel(arg));
    so.value = String(arg);
    srcSel.append(so);
    const dopt = el('option', '', argLabel(arg));
    dopt.value = String(arg);
    dstSel.append(dopt);
  }
  srcSel.value = String(currentArg());
  dstSel.value = String((currentArg() + 1) % 8);
  const arrow = el('span', 'hint', '→');
  const copyBtn = el('button', 'btn remap-copy', 'Stage copy');
  copyBtn.type = 'button';
  copyBtn.title = 'Stage a copy of one key set onto another (applied on Save, undoable)';
  copyBtn.addEventListener('click', () => {
    void copyLayer(Number(srcSel.value), Number(dstSel.value));
  });
  tools.append(copyLabel, srcSel, arrow, dstSel, copyBtn);
  kbody.append(tools);

  const holder = el('div', 'kb-holder');
  kbody.append(holder);
  keysView = new KeyboardView(holder, blocks, {
    onKeyClick: (n) => {
      // Ctrl/Shift/Cmd+click was already handled by the capture listener
      // (multi-toggle); a plain click collapses the selection to one key.
      if (!multiToggle) {
        selSet.clear();
        selSet.add(n);
      }
      multiToggle = false;
      selected = primaryOf();
      sync();
    },
  });

  // Multi-select: KeyboardView reports only the index, so modifier state
  // is read here in the capture phase (before the key's own click
  // handler). The key element's `title` starts with `Key <n> —`.
  holder.addEventListener(
    'click',
    (e) => {
      multiToggle = false;
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      const keyEl = (e.target as HTMLElement | null)?.closest?.('.kb-key');
      const m = /^Key (\d+)\b/.exec(keyEl?.getAttribute('title') ?? '');
      if (!m) return;
      const n = Number(m[1]);
      if (selSet.has(n)) selSet.delete(n);
      else selSet.add(n);
      multiToggle = true;
      // Keep `selected` = primary (most recent) member, null when empty.
      selected = primaryOf();
      sync();
    },
    true,
  );

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
  unassignBtn.title = 'Make the selected key(s) do nothing when pressed';
  unassignBtn.addEventListener('click', () => {
    assignToSelection(POOL_UNASSIGN.value);
  });
  const applyOneBtn = el('button', 'btn remap-apply-one', 'Save this key');
  applyOneBtn.type = 'button';
  applyOneBtn.addEventListener('click', () => {
    if (selected !== null && selSet.size <= 1) void applyOne(selected);
  });
  const resetKeyBtn = el('button', 'btn remap-reset-key', 'Reset key');
  resetKeyBtn.type = 'button';
  resetKeyBtn.title =
    'Stage the selected key(s) back to the value read from the keyboard (undoable)';
  resetKeyBtn.addEventListener('click', () => {
    stageIndices(selSet, null);
  });
  right.append(unassignBtn, resetKeyBtn, applyOneBtn);
  poolToolbar.append(right);
  pbody.append(poolToolbar);

  const searchRow = el('div', 'pool-search-row');
  const search = el('input', 'pool-search-input');
  search.type = 'search';
  search.placeholder = 'Search keys by name, usage or code…';
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
    const arg = currentArg();
    for (const entry of filteredPool()) {
      const item = el('button', 'pool-item', '');
      item.type = 'button';
      const name = el('span', 'pool-item-name', entry.name);
      item.append(name);
      // Tooltip carries the raw value + HID usage code (bead c8y).
      item.title =
        `${entry.name} — ${hex8(entry.value)}` +
        (entry.usage !== null
          ? ` · HID usage 0x${entry.usage.toString(16).padStart(2, '0').toUpperCase()}`
          : '');
      if (selected !== null && entry.value === effectiveValue(arg, selected)) {
        item.classList.add('pool-item--current');
      }
      item.addEventListener('click', () => {
        assignToSelection(entry.value);
      });
      grid.append(item);
    }
    if (grid.childElementCount === 0) {
      grid.append(el('p', 'hint', 'No keys match the search.'));
    }
  };

  /** Toggle the multi-select outline on rendered key caps. */
  const paintMultiSelect = (): void => {
    holder.querySelectorAll<HTMLElement>('.kb-key').forEach((k) => {
      const m = /^Key (\d+)\b/.exec(k.title);
      // Primary key keeps the solid "selected" outline instead.
      k.classList.toggle(
        'kb-key--multi',
        !!m && selSet.has(Number(m[1])) && Number(m[1]) !== selected,
      );
    });
  };

  syncPage = (): void => {
    const snap = app.snapshot;
    const arg = currentArg();
    const pending = edits.pendingView(arg);

    keysView?.setData({
      keymap: snap?.keymaps.get(arg) ?? null,
      colors: snap?.colors ?? null,
      pending: pending.size > 0 ? pending : null,
      selected,
    });
    paintMultiSelect();

    userModeBtn.classList.toggle('active', !systemMode);
    sysModeBtn.classList.toggle('active', systemMode);

    layerTabRefs.forEach((t, i) => {
      const tabArg = i | (systemMode ? 4 : 0);
      t.btn.classList.toggle('active', app.layer === i);
      const dirty = edits.pendingCount(tabArg) > 0;
      t.dot.hidden = !dirty;
      t.reset.disabled = busy || !dirty;
      t.reset.title = dirty
        ? `Reset ${argLabel(tabArg)} to the values read from the keyboard (staged)`
        : `${argLabel(tabArg)} has no unsaved changes`;
    });

    const count = pending.size;
    pendingBadge.textContent = count > 0 ? `${count} unsaved` : '';
    pendingBadge.hidden = count === 0;
    applyBtn.disabled = busy || count === 0;
    applyBtn.textContent = busy ? 'Saving…' : count > 0 ? `Save all (${count})` : 'Save';
    discardBtn.disabled = busy || count === 0;

    undoBtn.disabled = busy || !edits.canUndo();
    redoBtn.disabled = busy || !edits.canRedo();

    // Selected-key info + per-key apply. `selSet` is authoritative:
    // size 0 → nothing picked, 1 → single-key info, >1 → multi info.
    if (selSet.size > 1) {
      selInfo.className = 'pool-selected';
      selInfo.textContent =
        `${selSet.size} keys selected — picking a function applies it to all of them.`;
      applyOneBtn.disabled = true;
      dupWarn.textContent = '';
    } else if (selSet.size === 0 || selected === null) {
      selInfo.textContent = 'Click a key on the keyboard, then pick what it should do below.';
      selInfo.className = 'pool-selected hint';
      applyOneBtn.disabled = true;
      dupWarn.textContent = '';
    } else {
      const block = blockByIndex.get(selected);
      const committed = committedValue(arg, selected);
      const pend = pending.get(selected);
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
        const dup = duplicateSlots(arg, selected, pend);
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
    unassignBtn.disabled = busy || selSet.size === 0;
    resetKeyBtn.disabled = busy || selSet.size === 0;

    // Pool tabs + items.
    tabs.querySelectorAll('.pool-tab').forEach((b, i) => {
      b.classList.toggle('active', POOL_GROUPS[i]?.id === activeTab);
    });
    renderPoolItems();

    if (searchHadFocus && document.activeElement !== search) search.focus();
  };

  applyBtn.addEventListener('click', () => void applyAll());
  discardBtn.addEventListener('click', () => {
    // Discard = reset this key set to device-read values; staged only and
    // undoable via the StagedEdits history.
    resetLayerToRead(currentArg());
  });

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo-redo (skipped inside inputs).
  if (undoKeyHandler) document.removeEventListener('keydown', undoKeyHandler);
  undoKeyHandler = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if (k === 'y') {
      e.preventDefault();
      doRedo();
    }
  };
  document.addEventListener('keydown', undoKeyHandler);

  syncPage();
  keysUnsub = subscribe(() => syncPage?.());
  void ensureKeymap(currentArg()).catch(() => {});
}

/** Tear down the keys page (route change / unmount). */
export function destroyKeysPage(): void {
  keysView?.destroy();
  keysView = null;
  keysUnsub?.();
  keysUnsub = null;
  syncPage = null;
  if (undoKeyHandler) {
    document.removeEventListener('keydown', undoKeyHandler);
    undoKeyHandler = null;
  }
}
