/**
 * Layout editor UI — mounted by the `basic` page (pages-secondary.ts).
 *
 * Edits the VISUAL layout only: per-key position/size/rotation, custom
 * legends and hidden keycaps, previewed on an on-screen canvas. Everything
 * persists to localStorage (`omg.layout.v1.*`) — this module contains NO
 * HID/device writes by design (bead oh-my-gravastar-aur; the safety
 * contract's read-only default applies trivially: nothing is sent).
 *
 * The renderer is stateless: every edit is saved immediately, so the
 * page-level re-render on each state emit simply reloads the saved doc.
 * Key mapping (firmware function) is untouched — the editor only
 * references keymap slot indices for labels/ids.
 */

import {
  PHYSICAL_LAYOUTS,
  clearVisualLayout,
  emptyVisualDoc,
  findOverlaps,
  loadVisualLayout,
  physicalLayoutById,
  physicalLayoutForModel,
  resolveVisual,
  saveVisualLayout,
  validateVisualLayout,
  visualBounds,
  visualLayoutToJson,
  type PhysicalLayout,
  type VisualKeyOverride,
} from './layout-model.ts';
import type { KeyValueStorage } from './safety/snapshots.ts';

// ── DOM helpers (self-contained, mirrors pages-secondary.ts) ───────────

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

// ── Storage helpers ─────────────────────────────────────────────────────

const SEL_PREFIX = 'omg.layout.sel.';

function defaultStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // opaque origins
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function selKey(model: string | null): string {
  return `${SEL_PREFIX}${model ?? 'unknown'}`;
}

// ── Editor ──────────────────────────────────────────────────────────────

/** Currently selected key id — survives page re-renders (cosmetic only). */
let selectedKeyId: string | null = null;

export interface LayoutEditorEnv {
  /** catalogModel of the connected device (null when unknown). */
  model: string | null;
  /** Storage override for tests; defaults to localStorage. */
  storage?: KeyValueStorage;
}

/**
 * Mount the layout editor into `root` (a card body). Re-callable: each
 * call rebuilds the DOM from persisted state.
 */
export function mountLayoutEditor(root: HTMLElement, env: LayoutEditorEnv): void {
  root.replaceChildren();
  const storage = env.storage ?? defaultStorage();
  const model = env.model;

  if (PHYSICAL_LAYOUTS.length === 0) {
    root.append(el('p', 'hint warn', 'No physical layout tables are available.'));
    return;
  }

  // ── Choose physical layout (display metadata; default = model match) ──
  const matched = physicalLayoutForModel(model);
  const savedSel = storage.getItem(selKey(model));
  let layout: PhysicalLayout =
    (savedSel && physicalLayoutById(savedSel)) ||
    matched ||
    PHYSICAL_LAYOUTS[0] as PhysicalLayout;

  // ── Card: controls ──────────────────────────────────────────────────
  const ctl = card('Visual layout');
  ctl.body.append(
    el(
      'p',
      'hint',
      'Visual only — this changes how the keyboard looks on screen in this ' +
        'app. It is saved in this browser and is NEVER written to the keyboard.',
    ),
  );

  const row = el('div', 'ly-controls');
  const sel = el('select', 'ly-select') as HTMLSelectElement;
  for (const l of PHYSICAL_LAYOUTS) {
    const opt = el('option', '', `${l.name}${l.models.length ? '' : ' (generic)'}`) as HTMLOptionElement;
    opt.value = l.id;
    if (l.id === layout.id) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    const next = physicalLayoutById(sel.value);
    if (!next) return;
    layout = next;
    storage.setItem(selKey(model), next.id);
    selectedKeyId = null;
    mount();
  });
  row.append(el('label', 'ly-label', 'Physical layout'), sel);

  const resetBtn = el('button', 'sec-btn', 'Reset to physical') as HTMLButtonElement;
  resetBtn.type = 'button';
  resetBtn.title = 'Discard all visual overrides for this layout (browser-only)';
  resetBtn.addEventListener('click', () => {
    clearVisualLayout(model, layout.id, storage);
    selectedKeyId = null;
    mount();
  });
  row.append(resetBtn);
  ctl.body.append(row);

  const ioRow = el('div', 'ly-controls');
  const exportBtn = el('button', 'sec-btn', 'Export layout JSON') as HTMLButtonElement;
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', () => {
    const doc = loadVisualLayout(model, layout.id, storage) ?? emptyVisualDoc(layout.id, model);
    const blob = new Blob([visualLayoutToJson(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `omg-layout-${layout.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const importBtn = el('button', 'sec-btn', 'Import layout JSON') as HTMLButtonElement;
  importBtn.type = 'button';
  const fileInput = el('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.className = 'sec-file-input';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    void f.text().then((text) => {
      const v = validateVisualLayout(text, layout);
      const msgBox = root.querySelector<HTMLElement>('.ly-messages');
      if (!v.ok || !v.doc) {
        showMessages(msgBox, v.errors, v.warnings);
        return;
      }
      // Store under the document's own layout/model when valid.
      const doc = { ...v.doc, model: v.doc.model ?? model };
      saveVisualLayout(doc, storage);
      const target = physicalLayoutById(doc.layout);
      if (target && target.id !== layout.id) {
        layout = target;
        storage.setItem(selKey(model), target.id);
      }
      selectedKeyId = null;
      showMessages(msgBox, [], v.warnings);
      mount();
    });
  });
  importBtn.addEventListener('click', () => fileInput.click());
  ioRow.append(exportBtn, importBtn, fileInput);
  ctl.body.append(ioRow);

  const msgBox = el('div', 'ly-messages');
  ctl.body.append(msgBox);
  root.append(ctl.card);

  // ── Card: canvas preview ───────────────────────────────────────────
  const pv = card('Preview');
  pv.body.append(
    el(
      'p',
      'hint',
      'Click a key to edit it; drag to move. The Keys page still shows the ' +
        'real device layout — this canvas is the visual-layout preview only.',
    ),
  );
  const viewport = el('div', 'ly-viewport');
  const canvas = el('div', 'ly-canvas');
  viewport.append(canvas);
  pv.body.append(viewport);
  const detail = el('div', 'ly-detail');
  pv.body.append(detail);
  root.append(pv.card);

  // ── Card: selected-key editor ──────────────────────────────────────
  const ed = card('Selected key');
  const edBody = ed.body;
  root.append(ed.card);

  // ── Render ─────────────────────────────────────────────────────────
  function currentDoc() {
    return loadVisualLayout(model, layout.id, storage) ?? emptyVisualDoc(layout.id, model);
  }

  function setOverride(id: string, patch: VisualKeyOverride): void {
    const doc = currentDoc();
    const cur = { ...(doc.keys[id] ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (cur as Record<string, unknown>)[k];
      else (cur as Record<string, unknown>)[k] = v;
    }
    // Drop no-op overrides so the file stays clean.
    const physical = layout.keys.find((k) => k.id === id);
    if (physical) {
      if (cur.x === physical.x) delete cur.x;
      if (cur.y === physical.y) delete cur.y;
      if (cur.w === physical.width) delete cur.w;
      if (cur.h === physical.height) delete cur.h;
      if (cur.rotation === 0 || cur.rotation === undefined) delete cur.rotation;
      if (cur.legend === undefined || cur.legend === physical.name.replace(/_/g, ' ')) delete cur.legend;
      if (cur.hidden === false || cur.hidden === undefined) delete cur.hidden;
    }
    if (Object.keys(cur).length === 0) delete doc.keys[id];
    else doc.keys[id] = cur;
    saveVisualLayout(doc, storage);
  }

  function renderCanvas(): void {
    const resolved = resolveVisual(layout, currentDoc());
    const bounds = visualBounds(resolved);
    canvas.replaceChildren();
    canvas.style.width = `${Math.max(bounds.width, layout.unitPx)}px`;
    canvas.style.height = `${Math.max(bounds.height, layout.unitPx)}px`;

    // Fit to viewport width (recomputed each render; no RO — the page
    // re-renders on state emits anyway).
    const w = parseFloat(canvas.style.width);
    const h = parseFloat(canvas.style.height);
    const avail = viewport.clientWidth;
    const scale = avail > 0 && w > 0 ? Math.min(1, avail / w) : 1;
    canvas.style.transform = `scale(${scale})`;
    viewport.style.height = `${h * scale}px`;

    const overlaps = new Set<string>();
    for (const p of findOverlaps(resolved)) {
      overlaps.add(p.a);
      overlaps.add(p.b);
    }

    for (const k of resolved) {
      if (!k.display || k.hidden) continue;
      const keyEl = el('div', 'ly-key') as HTMLElement;
      keyEl.dataset.keyId = k.id;
      keyEl.style.left = `${k.vx}px`;
      keyEl.style.top = `${k.vy}px`;
      keyEl.style.width = `${k.vw}px`;
      keyEl.style.height = `${k.vh}px`;
      if (k.rotation !== 0) {
        keyEl.style.transform = `rotate(${k.rotation}deg)`;
      }
      if (k.id === selectedKeyId) keyEl.classList.add('ly-key--sel');
      if (overlaps.has(k.id)) keyEl.classList.add('ly-key--overlap');

      const label = el('span', 'ly-key-label', k.legend || '(blank)');
      if (k.rotation !== 0) label.style.transform = `rotate(${-k.rotation}deg)`;
      keyEl.append(label);
      keyEl.title = `${k.id} — ${k.name || 'unnamed'} (slot ${k.keyIndex})`;

      keyEl.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        selectedKeyId = k.id;
        keyEl.setPointerCapture(ev.pointerId);
        const startX = ev.clientX;
        const startY = ev.clientY;
        const origX = k.vx;
        const origY = k.vy;
        const phys = layout.keys.find((p) => p.id === k.id);
        const move = (me: PointerEvent) => {
          const dx = (me.clientX - startX) / scale;
          const dy = (me.clientY - startY) / scale;
          const nx = Math.round(origX + dx);
          const ny = Math.round(origY + dy);
          setOverride(k.id, { x: nx === phys?.x ? undefined : nx, y: ny === phys?.y ? undefined : ny });
          keyEl.style.left = `${nx}px`;
          keyEl.style.top = `${ny}px`;
        };
        const up = () => {
          keyEl.removeEventListener('pointermove', move);
          keyEl.removeEventListener('pointerup', up);
          keyEl.removeEventListener('pointercancel', up);
          renderPanel(); // refresh numeric fields with the dragged position
        };
        keyEl.addEventListener('pointermove', move);
        keyEl.addEventListener('pointerup', up);
        keyEl.addEventListener('pointercancel', up);
      });
      keyEl.addEventListener('click', () => {
        selectedKeyId = k.id;
        renderPanel();
      });
      canvas.append(keyEl);
    }
  }

  function numInput(
    label: string,
    value: number,
    onSet: (v: number | undefined) => void,
    physVal: number,
  ): HTMLElement {
    const wrap = el('label', 'ly-field');
    wrap.append(el('span', 'ly-field-label', label));
    const inp = el('input') as HTMLInputElement;
    inp.type = 'number';
    inp.className = 'ly-num';
    inp.value = String(value);
    inp.step = '1';
    inp.addEventListener('change', () => {
      const v = inp.value === '' ? NaN : Number(inp.value);
      onSet(Number.isFinite(v) && v !== physVal ? v : undefined);
      mount();
    });
    wrap.append(inp);
    return wrap;
  }

  function renderPanel(): void {
    edBody.replaceChildren();
    const resolved = resolveVisual(layout, currentDoc());
    const k = resolved.find((r) => r.id === selectedKeyId);
    if (!k || !k.display) {
      edBody.append(
        el('p', 'hint', 'Click a key on the canvas to edit its visual layout.'),
      );
      // Still surface overlap warnings globally.
      const ov = findOverlaps(resolved);
      if (ov.length > 0) {
        edBody.append(
          el('p', 'hint warn', `${ov.length} overlapping key pair(s) — see canvas highlights.`),
        );
      }
      return;
    }

    const doc = currentDoc();
    const o = doc.keys[k.id] ?? {};
    const phys = layout.keys.find((p) => p.id === k.id);

    edBody.append(
      el('p', 'hint', `${k.id} — ${phys?.name || 'unnamed'} · keymap slot ${k.keyIndex}`),
    );

    const grid = el('div', 'ly-grid');
    grid.append(
      numInput('x', o.x ?? k.vx, (v) => setOverride(k.id, { x: v }), phys?.x ?? 0),
      numInput('y', o.y ?? k.vy, (v) => setOverride(k.id, { y: v }), phys?.y ?? 0),
      numInput('w', o.w ?? k.vw, (v) => setOverride(k.id, { w: v }), phys?.width ?? 0),
      numInput('h', o.h ?? k.vh, (v) => setOverride(k.id, { h: v }), phys?.height ?? 0),
      numInput('rot°', o.rotation ?? k.rotation, (v) => setOverride(k.id, { rotation: v === undefined ? 0 : v }), 0),
    );
    edBody.append(grid);

    const legendWrap = el('label', 'ly-field');
    legendWrap.append(el('span', 'ly-field-label', 'legend'));
    const legendInp = el('input') as HTMLInputElement;
    legendInp.type = 'text';
    legendInp.className = 'ly-text';
    legendInp.maxLength = 128;
    legendInp.placeholder = phys?.name.replace(/_/g, ' ') ?? '';
    legendInp.value = o.legend ?? '';
    legendInp.addEventListener('change', () => {
      const v = legendInp.value;
      const physLegend = (phys?.name ?? '').replace(/_/g, ' ');
      setOverride(k.id, { legend: v === '' || v === physLegend ? undefined : v });
      mount();
    });
    legendWrap.append(legendInp);
    edBody.append(legendWrap);

    const hideWrap = el('label', 'ly-check');
    const hideInp = el('input') as HTMLInputElement;
    hideInp.type = 'checkbox';
    hideInp.checked = o.hidden ?? false;
    hideInp.addEventListener('change', () => {
      setOverride(k.id, { hidden: hideInp.checked ? true : undefined });
      mount();
    });
    hideWrap.append(hideInp, document.createTextNode(' hide this keycap (visual only)'));
    edBody.append(hideWrap);

    const resetKey = el('button', 'sec-btn', 'Reset this key') as HTMLButtonElement;
    resetKey.type = 'button';
    resetKey.addEventListener('click', () => {
      const d = currentDoc();
      delete d.keys[k.id];
      saveVisualLayout(d, storage);
      mount();
    });
    edBody.append(resetKey);
  }

  function showMessages(
    box: HTMLElement | null,
    errors: string[],
    warnings: string[],
  ): void {
    if (!box) return;
    box.replaceChildren();
    for (const e of errors) box.append(el('p', 'hint warn', `Error: ${e}`));
    for (const w of warnings) box.append(el('p', 'hint', `Note: ${w}`));
    if (errors.length === 0 && warnings.length === 0) {
      box.append(el('p', 'hint', 'Layout imported.'));
    }
  }

  function mount(): void {
    renderCanvas();
    renderPanel();
  }

  mount();
}
