/**
 * Keyboard visualizer — DOM-grid renderer ported from the vendor
 * `Keyboard-*.js` + `keyShape-*.js` approach: one absolutely-positioned
 * `<div>` per key block, geometry in the vendor's px units (44 px unit
 * key), per-key `background: rgb(r,g,b)` and auto black/white legend via
 * the vendor luminance formula `0.299r + 0.587g + 0.114b`.
 *
 * Differences from the vendor component (read-only MVP):
 * - no drag/drop, no K98 product-PNG background, no screen overlay;
 * - labels come from the live keymap decode (`keyValueLabel`), falling
 *   back to the layout's factory `name`;
 * - the whole canvas is scaled to fit its container width (the vendor
 *   achieves the same via rem + root font-size).
 */

import { keyIndexOf, layoutBounds, type KeyBlock } from './k1pro-layout.ts';
import type { KeyEntry } from './state.ts';
import { keyValueLabelOf, type LightColor } from './proto/khub916.ts';
import { t } from './i18n.ts';

/** Vendor luminance threshold: >128 → black text, else white. */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export interface KeyboardData {
  /** Decoded keymap for the selected layer (`keymaps[layer]`). */
  keymap: readonly KeyEntry[] | null;
  /** cmd 134 colours; entry `i` ↔ key index `i` (`pos = 8 + i*4`). */
  colors: readonly LightColor[] | null;
  /** Pending (unsaved) remap values per slot index — keys page only. */
  pending?: ReadonlyMap<number, number> | null;
  /** Currently selected slot index (picker target highlight). */
  selected?: number | null;
}

export interface KeyboardViewOptions {
  /** Called with the keymap index `n` (`pos = 8 + n*4`) on key click. */
  onKeyClick?: (keyIndex: number) => void;
}

export class KeyboardView {
  private readonly viewport: HTMLElement;
  private readonly canvas: HTMLElement;
  private readonly detail: HTMLElement;
  private blocks: readonly KeyBlock[];
  private data: KeyboardData = { keymap: null, colors: null };
  private scale = 1;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onKeyClick?: (keyIndex: number) => void;

  constructor(root: HTMLElement, blocks: readonly KeyBlock[], opts: KeyboardViewOptions = {}) {
    this.onKeyClick = opts.onKeyClick;
    this.blocks = blocks;
    this.viewport = document.createElement('div');
    this.viewport.className = 'kb-viewport';
    this.canvas = document.createElement('div');
    this.canvas.className = 'kb-canvas';
    this.detail = document.createElement('div');
    this.detail.className = 'kb-detail';
    this.viewport.append(this.canvas);
    root.append(this.viewport, this.detail);
    this.render();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.viewport);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.viewport.remove();
    this.detail.remove();
  }

  setData(data: KeyboardData): void {
    this.data = data;
    this.render();
  }

  private colorFor(block: KeyBlock): { r: number; g: number; b: number } | null {
    const colors = this.data.colors;
    if (!colors) return null;
    const c = colors[keyIndexOf(block.pos)];
    return c ? { r: c.r, g: c.g, b: c.b } : null;
  }

  private labelFor(block: KeyBlock, n: number): string {
    // A pending remap shows the value it will become (vendor marks the
    // key `replaced` and swaps the name immediately on pick).
    const pending = this.data.pending?.get(n);
    if (pending !== undefined) return keyValueLabelOf(pending) || t('common.noneShort');
    const km = this.data.keymap;
    if (km) {
      const entry = km[n];
      if (entry?.label) return entry.label;
    }
    // Fall back to the factory name, prettified ('L_shift' → 'L Shift').
    return block.name.replace(/_/g, ' ');
  }

  private render(): void {
    const bounds = layoutBounds(this.blocks);
    this.canvas.replaceChildren();
    this.canvas.style.width = `${bounds.width}px`;
    this.canvas.style.height = `${bounds.height}px`;

    for (const block of this.blocks) {
      if (!block.display) continue;
      const n = keyIndexOf(block.pos);
      const el = document.createElement('div');
      el.className = 'kb-key';
      el.style.left = `${block.x}px`;
      el.style.top = `${block.y}px`;
      el.style.width = `${block.width}px`;
      el.style.height = `${block.height}px`;

      const color = this.colorFor(block);
      if (color) {
        el.style.background = `rgb(${color.r},${color.g},${color.b})`;
        el.style.color = luminance(color.r, color.g, color.b) > 128 ? '#000' : '#fff';
      } else {
        el.classList.add('kb-key--idle');
      }

      const dirty = this.data.pending?.has(n) ?? false;
      const selected = this.data.selected === n;
      if (dirty) el.classList.add('kb-key--dirty');
      if (selected) el.classList.add('kb-key--selected');

      const label = this.labelFor(block, n);
      const text = document.createElement('span');
      text.className = 'kb-key-label';
      text.textContent = label;
      if (dirty) {
        const dot = document.createElement('span');
        dot.className = 'kb-key-dirty';
        el.append(dot);
      }
      el.append(text);

      const km = this.data.keymap?.[n];
      const pv = this.data.pending?.get(n);
      const curLabel = km?.label || (km ? t('common.empty') : '');
      const name = block.name || t('common.unnamed');
      el.title =
        t('kb.keyTitle', { n, label: curLabel || name }) +
        (km ? ` · 0x${km.value.toString(16).toUpperCase().padStart(8, '0')}` : '') +
        (pv !== undefined
          ? ` ${t('kb.willBecome', { hex: pv.toString(16).toUpperCase().padStart(8, '0') })}`
          : '');
      el.addEventListener('click', () => {
        this.onKeyClick?.(n);
        const shown = pv !== undefined ? keyValueLabelOf(pv) || t('common.noneShort') : curLabel;
        this.detail.textContent = km
          ? `#${n} ${name} → ${shown}${pv !== undefined ? ` ${t('kb.unsaved')}` : ''}`
          : name;
      });
      this.canvas.append(el);
    }
    this.fit();
  }

  /** Scale the px canvas to fit the viewport width (vendor rem approach). */
  private fit(): void {
    const bounds = layoutBounds(this.blocks);
    const avail = this.viewport.clientWidth;
    this.scale = avail > 0 ? Math.min(1, avail / bounds.width) : 1;
    this.canvas.style.transform = `scale(${this.scale})`;
    this.viewport.style.height = `${bounds.height * this.scale}px`;
  }
}
