/**
 * Lighting page (`lightingEffect` clone) — bead oh-my-gravastar-far.
 *
 * Layout mirrors the vendor page (docs/research/khub-webapp/
 * LightingEffect-BD4spz4j.js + lightingStore): effect/mode selector from
 * the 18-entry LIGHT_MODES table, speed + brightness sliders (vendor
 * limit 0–20), an HSV colour picker (SV canvas + hue slider + hex/RGB
 * inputs), per-key custom colours (126 slots, presets solid/gradient/
 * rainbow) and a JSON view/export of the `omg kb916 light apply` config
 * (docs/lighting-schema.md).
 *
 * Apply mirrors `crates/omg/src/kb916_light.rs::cmd_apply`: resolve every
 * field against a fresh device read, then write cmd 6 custom colours →
 * cmd 4 profile → cmd 10 group colour, each read-back verified inside
 * `Khub916Session`. A confirm dialog shows the exact JSON first — the
 * web equivalent of the CLI's `--yes` gate.
 *
 * The view instance survives state emits (subscribe re-renders call
 * `syncLive`, which only refreshes readouts and re-seeds drafts while
 * they are pristine).
 */

import { app, connect, ensureKeymap, refresh, subscribe, setStatus } from './state.ts';
import { K1_PRO_BLOCKS } from './k1pro-layout.ts';
import { KeyboardView } from './keyboard.ts';
import {
  COLOR_MODEL,
  COLOR_SUPPORT,
  CUSTOM_LIGHT_SLOTS,
  LIGHT_MODES,
  LIGHT_SPECIAL_MODES,
  buildPresetColors,
  colorsEqual,
  decodeLightState,
  groupColor,
  hsvToRgb,
  lightModeInfo,
  parseColor,
  rgbToHex,
  rgbToHsv,
  withGroupColor,
  withLightMode,
  type KeysPreset,
  type LightModeInfo,
  type Rgb,
} from './proto/light.ts';
import type { LightColor } from './proto/khub916.ts';

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

// ── HSV colour picker (vendor: SV square + hue slider + hex/RGB) ───────

const PICKER_SIZE = 180;

class ColorPicker {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private hue: HTMLInputElement;
  private hexInput: HTMLInputElement;
  private rgbInputs: HTMLInputElement[];
  private sv = { s: 1, v: 1 };
  private h = 0;
  private color: Rgb = { r: 255, g: 255, b: 255 };
  private dragging = false;
  onChange: ((c: Rgb) => void) | null = null;

  constructor() {
    this.root = el('div', 'colorpicker');

    this.canvas = document.createElement('canvas');
    this.canvas.width = PICKER_SIZE;
    this.canvas.height = PICKER_SIZE;
    this.canvas.className = 'cp-sv';
    this.root.append(this.canvas);

    const hueRow = el('div', 'cp-row');
    hueRow.append(el('label', 'cp-label', 'Colour'));
    this.hue = document.createElement('input');
    this.hue.type = 'range';
    this.hue.min = '0';
    this.hue.max = '359';
    this.hue.value = '0';
    this.hue.className = 'cp-hue';
    hueRow.append(this.hue);
    this.root.append(hueRow);

    const hexRow = el('div', 'cp-row');
    hexRow.append(el('label', 'cp-label', 'Colour code'));
    this.hexInput = document.createElement('input');
    this.hexInput.type = 'text';
    this.hexInput.className = 'cp-hex mono';
    this.hexInput.maxLength = 7;
    hexRow.append(this.hexInput);
    this.root.append(hexRow);

    const rgbRow = el('div', 'cp-row cp-rgb');
    this.rgbInputs = [];
    for (const ch of ['R', 'G', 'B'] as const) {
      const lab = el('label', 'cp-label', ch);
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '255';
      inp.className = 'cp-num mono';
      rgbRow.append(lab, inp);
      this.rgbInputs.push(inp);
    }
    this.root.append(rgbRow);

    // SV canvas interactions.
    const pos = (e: PointerEvent | MouseEvent): { s: number; v: number } => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      return { s: x, v: 1 - y };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.sv = p;
      this.emit();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.sv = pos(e);
      this.emit();
    });
    this.canvas.addEventListener('pointerup', () => {
      this.dragging = false;
    });

    this.hue.addEventListener('input', () => {
      this.h = Number(this.hue.value);
      this.emit();
    });
    this.hexInput.addEventListener('change', () => {
      try {
        this.set(parseColor(this.hexInput.value, 'hex'));
      } catch {
        this.refreshInputs();
      }
    });
    for (const inp of this.rgbInputs) {
      inp.addEventListener('change', () => this.emitFromInputs());
    }
    this.paint();
  }

  get value(): Rgb {
    return { ...this.color };
  }

  /** Set the picker colour (updates canvas + inputs). */
  set(c: Rgb): void {
    this.color = { r: c.r & 0xff, g: c.g & 0xff, b: c.b & 0xff };
    const hsv = rgbToHsv(this.color);
    this.h = hsv.h;
    this.sv = { s: hsv.s, v: hsv.v };
    this.hue.value = String(Math.round(this.h));
    this.paint();
    this.refreshInputs();
  }

  private emit(): void {
    this.color = hsvToRgb(this.h, this.sv.s, this.sv.v);
    this.hue.value = String(Math.round(this.h));
    this.paint();
    this.refreshInputs();
    this.onChange?.({ ...this.color });
  }

  private emitFromInputs(): void {
    const [r, g, b] = this.rgbInputs.map((i) => {
      const n = Number(i.value);
      return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : 0;
    });
    this.set({ r: r as number, g: g as number, b: b as number });
    this.onChange?.({ ...this.color });
  }

  private refreshInputs(): void {
    this.hexInput.value = rgbToHex(this.color);
    this.rgbInputs[0]!.value = String(this.color.r);
    this.rgbInputs[1]!.value = String(this.color.g);
    this.rgbInputs[2]!.value = String(this.color.b);
  }

  /** Draw the SV square (white→hue horizontal, transparent→hue vertical)
   *  plus the hue slider gradient and the current-colour marker. */
  private paint(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const size = PICKER_SIZE;
    const hueRgb = hsvToRgb(this.h, 1, 1);
    const hueCss = `rgb(${hueRgb.r},${hueRgb.g},${hueRgb.b})`;
    // Horizontal: white → hue colour; vertical alpha via destination-out
    // gradient is complex — paint rows instead.
    for (let y = 0; y < size; y++) {
      const v = 1 - y / (size - 1);
      const top = `rgb(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)})`;
      const g = ctx.createLinearGradient(0, y, size, y);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, hueCss);
      void top;
      ctx.fillStyle = g;
      ctx.globalAlpha = v;
      ctx.fillRect(0, y, size, 1);
    }
    ctx.globalAlpha = 1;
    // Hue slider gradient.
    const hueGrad = ctx.createLinearGradient(0, 0, size, 0);
    for (let i = 0; i <= 6; i++) {
      const c = hsvToRgb(i * 60, 1, 1);
      hueGrad.addColorStop(i / 6, `rgb(${c.r},${c.g},${c.b})`);
    }
    // Paint hue gradient onto the range input via a backing canvas is not
    // possible for <input type=range>; use a CSS gradient on the wrapper.
    this.hue.style.background = `linear-gradient(to right, ${hueGradCss()})`;
    this.hue.style.height = '10px';
    this.hue.style.borderRadius = '5px';
    // Marker on SV canvas.
    const mx = this.sv.s * (size - 1);
    const my = (1 - this.sv.v) * (size - 1);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function hueGradCss(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 6; i++) {
    const c = hsvToRgb(i * 60, 1, 1);
    stops.push(`rgb(${c.r},${c.g},${c.b}) ${(i / 6) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(',')})`;
}

// ── Apply config builder (docs/lighting-schema.md) ─────────────────────

interface ResolvedState {
  mode: number;
  speed: number;
  brightness: number;
  colorModel: number;
  /** Group colour to write via cmd 10, or null. */
  groupColor: Rgb | null;
  /** Custom 126-slot table to write via cmd 6, or null. */
  customColors: Rgb[] | null;
}

// ── Lighting view ──────────────────────────────────────────────────────

type PickerTarget = { kind: 'effect' } | { kind: 'key'; index: number };

class LightingView {
  private root: HTMLElement;
  private unsub: () => void;
  private kbView: KeyboardView | null = null;
  private kbHolder!: HTMLElement;

  // Draft state (edited by the user; pristine = mirrors device).
  private mode = 0;
  private speed = 0;
  private brightness = 0;
  private colorModel: number = COLOR_MODEL.MIXING;
  private effectColor: Rgb = { r: 255, g: 255, b: 255 };
  private customColors: Rgb[] = [];
  private dirty = false;
  private applying = false;

  // Widgets.
  private modeGrid!: HTMLElement;
  private readonly modeCards = new Map<number, HTMLButtonElement>();
  private speedRange!: HTMLInputElement;
  private speedVal!: HTMLElement;
  private brightRange!: HTMLInputElement;
  private brightVal!: HTMLElement;
  private modelRadios!: HTMLInputElement[];
  private picker!: ColorPicker;
  private targetBtns!: HTMLButtonElement[];
  private target: PickerTarget = { kind: 'effect' };
  private presetKind: KeysPreset | '' = '';
  private presetBtns: HTMLButtonElement[] = [];
  private presetColor!: HTMLInputElement;
  private presetTo!: HTMLInputElement;
  private slotGrid!: HTMLElement;
  private selectedSlot: number | null = null;
  private jsonPre!: HTMLElement;
  private applyBtn!: HTMLButtonElement;
  private stepLog!: HTMLElement;
  private liveLine!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.unsub = subscribe(() => this.syncLive());
    this.build();
    this.syncLive(true);
  }

  destroy(): void {
    this.unsub();
    this.kbView?.destroy();
    this.kbView = null;
  }

  // ── Build ──────────────────────────────────────────────────────────

  /** Decorative gradient hint for a mode card (purpose: quick visual
   *  scan of which effects are multi-colour vs single/off). */
  private modeThumbStyle(id: number): string {
    const info = lightModeInfo(id);
    if (id === 0 || info?.colorSupport === COLOR_SUPPORT.OFF) {
      return 'linear-gradient(135deg,#26282b,#101314)';
    }
    if (info?.colorSupport === COLOR_SUPPORT.MULTI) {
      return 'linear-gradient(90deg,#ff5f6d,#ffc371,#7bed9f,#70a1ff,#a55eea,#ff5f6d)';
    }
    if (info?.colorSupport === COLOR_SUPPORT.CUSTOM) {
      return 'linear-gradient(90deg,#c6f54e,#70a1ff,#ff5f6d,#ffc371)';
    }
    // Single-colour modes — soft accent tint so they read differently
    // from the multi-colour rainbow thumbs at a glance.
    return 'linear-gradient(135deg,rgba(198,245,78,0.4),#26282b)';
  }

  private modeLabel(id: number): string {
    const name = lightModeInfo(id)?.name ?? `mode ${id}`;
    return name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  private build(): void {
    this.root.replaceChildren();

    // Hero — the keyboard itself is the home screen.
    const hero = el('div', 'kb-hero');
    this.kbHolder = el('div', 'kb-holder');
    hero.append(this.kbHolder);
    this.root.append(hero);

    // Card — pick an effect. This is the whole primary flow.
    const fx = card('Pick an effect');
    this.liveLine = el('p', 'hint live-line', '');
    fx.body.append(this.liveLine);
    fx.body.append(
      el('p', 'hint', 'Tap an effect — the keyboard above shows it straight away. Save when it looks right.'),
    );
    this.modeGrid = el('div', 'mode-grid');
    for (const m of LIGHT_MODES) {
      const b = el('button', 'mode-card');
      b.type = 'button';
      const thumb = el('span', 'mode-thumb');
      thumb.style.background = this.modeThumbStyle(m.id);
      b.append(thumb, el('span', 'mode-name', this.modeLabel(m.id)));
      b.addEventListener('click', () => {
        this.mode = m.id;
        this.onModeChange();
        this.markDirty();
      });
      this.modeCards.set(m.id, b);
      this.modeGrid.append(b);
    }
    fx.body.append(this.modeGrid);
    this.root.append(fx.card);

    // Card — one-tap colour fills (the "Custom" effect + per-key colours).
    const custom = card('Colours');
    custom.body.append(
      el(
        'p',
        'hint',
        'Tap a fill to colour every key at once. These apply to the "Custom" ' +
          'effect and to individual keys.',
      ),
    );

    const presetGrid = el('div', 'preset-grid');
    const presetDefs: { kind: KeysPreset; label: string; hint: string; thumb: string }[] = [
      {
        kind: 'solid',
        label: 'Solid',
        hint: 'One colour everywhere',
        thumb: 'linear-gradient(135deg,#ff5f6d,#ff5f6d)',
      },
      {
        kind: 'gradient',
        label: 'Gradient',
        hint: 'Blend between two colours',
        thumb: 'linear-gradient(90deg,#ff5f6d,#ffc371,#70a1ff)',
      },
      {
        kind: 'rainbow',
        label: 'Rainbow',
        hint: 'Every colour of the wheel',
        thumb: 'linear-gradient(90deg,#ff5f6d,#ffc371,#7bed9f,#70a1ff,#a55eea,#ff5f6d)',
      },
    ];
    this.presetBtns = [];
    presetDefs.forEach((p, pi) => {
      const b = el('button', 'preset-card');
      b.type = 'button';
      const thumb = el('span', 'preset-thumb');
      thumb.style.background = p.thumb;
      b.append(thumb, el('span', '', p.label), el('span', 'preset-hint', p.hint));
      b.addEventListener('click', () => {
        this.presetKind = p.kind;
        this.presetBtns.forEach((pb, i) => pb.classList.toggle('active', i === pi));
        this.applyPreset();
      });
      this.presetBtns.push(b);
      presetGrid.append(b);
    });
    custom.body.append(presetGrid);

    const presetRow = el('div', 'light-row');
    presetRow.append(el('label', 'cp-label', 'From'));
    this.presetColor = document.createElement('input');
    this.presetColor.type = 'color';
    this.presetColor.value = '#ff0000';
    this.presetColor.addEventListener('input', () => {
      if (this.presetKind) this.applyPreset();
    });
    presetRow.append(this.presetColor);
    presetRow.append(el('label', 'cp-label', 'To'));
    this.presetTo = document.createElement('input');
    this.presetTo.type = 'color';
    this.presetTo.value = '#0000ff';
    this.presetTo.addEventListener('input', () => {
      if (this.presetKind) this.applyPreset();
    });
    presetRow.append(this.presetTo);
    const revertBtn = el('button', 'btn', 'Undo fill');
    revertBtn.type = 'button';
    revertBtn.title = 'Put the saved key colours back';
    revertBtn.addEventListener('click', () => {
      this.presetKind = '';
      this.presetBtns.forEach((pb) => pb.classList.remove('active'));
      this.revertCustom();
    });
    presetRow.append(revertBtn);
    custom.body.append(presetRow);
    this.root.append(custom.card);

    // Everything else is one collapsed "More options" section.
    const adv = el('details', 'advanced');
    adv.append(el('summary', '', 'More options — speed, brightness, custom colour, per-key'));
    const advBody = el('div', 'advanced-body');

    const sliders = el('div', 'light-sliders');
    sliders.append(
      this.slider('Speed', (range, valEl) => {
        this.speedRange = range;
        this.speedVal = valEl;
      }, (v) => {
        this.speed = v;
        this.markDirty();
      }),
    );
    sliders.append(
      this.slider('Brightness', (range, valEl) => {
        this.brightRange = range;
        this.brightVal = valEl;
      }, (v) => {
        this.brightness = v;
        this.markDirty();
      }),
    );
    advBody.append(sliders);

    // Colour model radios (single-colour modes only).
    const modelRow = el('div', 'light-row');
    modelRow.append(el('label', 'cp-label', 'Colour style'));
    this.modelRadios = [];
    for (const [label, val] of [
      ['One colour', COLOR_MODEL.MONOCHROME],
      ['Mixed colours', COLOR_MODEL.MIXING],
    ] as const) {
      const lab = el('label', 'cp-radio');
      const inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = 'light-color-model';
      inp.value = String(val);
      inp.addEventListener('change', () => {
        if (inp.checked) {
          this.colorModel = val;
          this.markDirty();
          this.syncPickerTarget();
        }
      });
      lab.append(inp, document.createTextNode(` ${label}`));
      modelRow.append(lab);
      this.modelRadios.push(inp);
    }
    advBody.append(modelRow);

    // Custom colour picker + per-key grid.
    const pickRow = el('div', 'light-pickrow');
    this.picker = new ColorPicker();
    this.picker.onChange = (c) => this.onPickerColor(c);
    pickRow.append(this.picker.root);

    const targetCol = el('div', 'light-target');
    targetCol.append(el('div', 'cp-label', 'Colour picker changes'));
    this.targetBtns = [];
    const mkTarget = (label: string, t: PickerTarget): HTMLButtonElement => {
      const b = el('button', 'segment-item', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        this.target = t;
        this.syncPickerTarget();
      });
      this.targetBtns.push(b);
      targetCol.append(b);
      return b;
    };
    mkTarget('The whole effect', { kind: 'effect' });
    mkTarget(`Key ${this.selectedSlot ?? 0}`, { kind: 'key', index: 0 });
    pickRow.append(targetCol);
    advBody.append(pickRow);

    advBody.append(
      el(
        'p',
        'hint',
        'Fine-tune colours by hand: pick "The whole effect" or a key, then ' +
          'choose a colour above. Click a key on the keyboard or a square ' +
          'below to choose which key the picker edits.',
      ),
    );
    this.slotGrid = el('div', 'slotgrid');
    advBody.append(this.slotGrid);
    adv.append(advBody);
    this.root.append(adv);

    // Settings file (JSON) — for backups and the omg CLI.
    const jsonDetails = el('details', 'advanced');
    jsonDetails.append(el('summary', '', 'Settings file (JSON) — backups & the omg CLI'));
    const jsonBody = el('div', 'advanced-body');
    const jsonRow = el('div', 'light-row');
    const copyBtn = el('button', 'btn', 'Copy');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.configJson()).then(() => setStatus('Settings JSON copied.'));
    });
    const dlBtn = el('button', 'btn', 'Download .json');
    dlBtn.type = 'button';
    dlBtn.addEventListener('click', () => this.downloadJson());
    jsonRow.append(copyBtn, dlBtn);
    jsonBody.append(jsonRow);
    this.jsonPre = el('pre', 'json-view mono');
    jsonBody.append(this.jsonPre);
    jsonDetails.append(jsonBody);
    this.root.append(jsonDetails);

    // One save bar — always visible, bottom of the page.
    const bar = el('div', 'light-savebar');
    const btnRow = el('div', 'light-row light-savebar-row');
    this.applyBtn = el('button', 'apply-btn light-save', 'Save lighting');
    this.applyBtn.type = 'button';
    this.applyBtn.addEventListener('click', () => void this.confirmAndApply());
    const resetBtn = el('button', 'btn', 'Undo changes');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      this.dirty = false;
      this.syncLive(true);
    });
    btnRow.append(this.applyBtn, resetBtn);
    bar.append(btnRow);
    this.stepLog = el('div', 'step-log');
    bar.append(this.stepLog);
    this.root.append(bar);

    this.renderSlotGrid();
    this.renderKeyboard();
    this.updateJson();
  }

  /** 0–20 range slider (vendor VerticalSlider equivalent, horizontal). */
  private slider(
    label: string,
    bind: (range: HTMLInputElement, valEl: HTMLElement) => void,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap = el('div', 'light-slider');
    wrap.append(el('label', 'cp-label', label));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '20';
    range.value = '0';
    const valEl = el('span', 'light-val mono', '0');
    range.addEventListener('input', () => {
      const v = Number(range.value);
      valEl.textContent = String(v);
      onInput(v);
    });
    wrap.append(range, valEl);
    bind(range, valEl);
    return wrap;
  }

  // ── State sync ─────────────────────────────────────────────────────

  /** Re-read live state into the readout card; reseed drafts if pristine. */
  syncLive(force = false): void {
    const snap = app.snapshot;
    if (!snap) {
      this.root.replaceChildren(
        el('p', 'hint', 'Connect a keyboard to configure lighting.'),
      );
      return;
    }
    const st = decodeLightState(snap.profile.raw);
    const info = st ? lightModeInfo(st.mode) : undefined;
    const nonBlack = snap.colors.filter((c) => c.r || c.g || c.b).length;
    if (st) {
      const name = info ? this.modeLabel(st.mode) : `effect ${st.mode} (unknown)`;
      this.liveLine.textContent =
        `On your keyboard now: ${name} · speed ${st.speed} · ` +
        `brightness ${st.brightness} · ${nonBlack} key${nonBlack === 1 ? '' : 's'} customised`;
    } else {
      this.liveLine.textContent =
        'On your keyboard now: could not read the current effect.';
    }

    if ((!this.dirty || force) && !this.applying) {
      this.seedFromSnapshot(snap);
    }
    this.updateControls();
    this.updateJson();
  }

  private seedFromSnapshot(snap: NonNullable<typeof app.snapshot>): void {
    const st = decodeLightState(snap.profile.raw);
    this.mode = st?.mode ?? 0;
    this.speed = st?.speed ?? 0;
    this.brightness = st?.brightness ?? 0;
    this.colorModel = st?.colorModel ?? COLOR_MODEL.MIXING;
    const gc = st ? groupColor(snap.lightData, st.mode) : null;
    this.effectColor = gc ?? { r: 255, g: 255, b: 255 };
    this.customColors = snap.colors.map((c) => ({ r: c.r, g: c.g, b: c.b }));
    if (this.customColors.length !== CUSTOM_LIGHT_SLOTS) {
      this.customColors = Array.from({ length: CUSTOM_LIGHT_SLOTS }, () => ({ r: 0, g: 0, b: 0 }));
    }
    this.selectedSlot = null;
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
    this.updateJson();
  }

  // ── Controls ───────────────────────────────────────────────────────

  private modeInfo(): LightModeInfo | undefined {
    return lightModeInfo(this.mode);
  }

  private onModeChange(): void {
    const info = this.modeInfo();
    // Vendor default colour model when the mode changes.
    if (info) this.colorModel = info.defaultColorModel;
    const st = app.snapshot ? decodeLightState(app.snapshot.profile.raw) : null;
    if (st && st.mode === this.mode) {
      // Re-selecting the live mode: restore live speed/brightness.
      this.speed = st.speed;
      this.brightness = st.brightness;
      this.colorModel = st.colorModel;
    }
    this.updateControls();
    this.syncPickerTarget();
  }

  private updateControls(): void {
    // Mode cards — mark the active one; surface off-table live modes.
    const st = app.snapshot ? decodeLightState(app.snapshot.profile.raw) : null;
    let known = false;
    for (const [id, card] of this.modeCards) {
      const active = id === this.mode;
      card.classList.toggle('active', active);
      if (active) known = true;
    }
    this.modeGrid.querySelector('.mode-card-unknown')?.remove();
    if (!known && st && st.mode === this.mode) {
      this.modeGrid.append(
        el('div', 'mode-card mode-card-unknown', `Current effect ${st.mode} (not in table)`),
      );
    }

    const info = this.modeInfo();
    const special = LIGHT_SPECIAL_MODES.includes(this.mode);
    const speedAdj = info ? info.speedAdjustable && !special : !special;
    this.speedRange.disabled = !speedAdj;
    this.speedRange.value = String(this.speed);
    this.speedVal.textContent = String(this.speed);
    this.brightRange.disabled = special;
    this.brightRange.value = String(this.brightness);
    this.brightVal.textContent = String(this.brightness);

    // Colour model radios: only for single-colour modes.
    const showModel = info?.colorSupport === COLOR_SUPPORT.SINGLE;
    for (const r of this.modelRadios) {
      r.disabled = !showModel;
      r.checked = r.value === String(this.colorModel);
    }
    (this.modelRadios[0]!.closest('.light-row') as HTMLElement).style.display = showModel ? '' : 'none';

    this.syncPickerTarget();
    this.renderSlotGrid();
    this.renderKeyboard();
  }

  private pickerAppliesToEffect(): boolean {
    const info = this.modeInfo();
    return (
      info?.colorSupport === COLOR_SUPPORT.SINGLE &&
      this.colorModel === COLOR_MODEL.MONOCHROME &&
      groupColor(app.snapshot?.lightData ?? new Uint8Array(0), this.mode) !== null
    );
  }

  private syncPickerTarget(): void {
    const effectOk = this.pickerAppliesToEffect();
    const [effectBtn, keyBtn] = this.targetBtns;
    effectBtn!.disabled = !effectOk;
    keyBtn!.disabled = this.customColors.length === 0;
    keyBtn!.textContent = `Key ${this.selectedSlot ?? 0}`;
    if (this.target.kind === 'effect' && !effectOk) {
      this.target = { kind: 'key', index: this.selectedSlot ?? 0 };
    }
    effectBtn!.classList.toggle('active', this.target.kind === 'effect');
    keyBtn!.classList.toggle('active', this.target.kind === 'key');
    const c = this.currentPickerColor();
    this.picker.set(c);
  }

  private currentPickerColor(): Rgb {
    if (this.target.kind === 'effect') return this.effectColor;
    return this.customColors[this.target.index] ?? { r: 0, g: 0, b: 0 };
  }

  private onPickerColor(c: Rgb): void {
    if (this.target.kind === 'effect') {
      this.effectColor = c;
    } else {
      this.customColors[this.target.index] = c;
    }
    this.markDirty();
    this.renderSlotGrid();
    this.renderKeyboard();
  }

  // ── Custom colours ─────────────────────────────────────────────────

  private applyPreset(): void {
    const p = this.presetKind;
    if (!p) return;
    try {
      this.customColors = buildPresetColors({
        preset: p,
        color: this.presetColor.value,
        to: this.presetTo.value,
      });
      this.markDirty();
      this.syncPickerTarget();
      this.renderSlotGrid();
      this.renderKeyboard();
    } catch (e) {
      setStatus(`Could not apply that fill: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  private revertCustom(): void {
    const snap = app.snapshot;
    if (!snap) return;
    this.customColors = snap.colors.map((c) => ({ r: c.r, g: c.g, b: c.b }));
    this.markDirty();
    this.syncPickerTarget();
    this.renderSlotGrid();
    this.renderKeyboard();
  }

  private selectSlot(index: number): void {
    this.selectedSlot = index;
    this.target = { kind: 'key', index };
    this.syncPickerTarget();
    this.renderSlotGrid();
  }

  private renderSlotGrid(): void {
    this.slotGrid.replaceChildren();
    for (let i = 0; i < CUSTOM_LIGHT_SLOTS; i++) {
      const c = this.customColors[i] ?? { r: 0, g: 0, b: 0 };
      const cell = el('button', 'slot');
      cell.type = 'button';
      cell.style.background = `rgb(${c.r},${c.g},${c.b})`;
      cell.classList.toggle('selected', this.selectedSlot === i);
      cell.title = `Key ${i} — ${rgbToHex(c)}`;
      cell.textContent = String(i);
      cell.addEventListener('click', () => this.selectSlot(i));
      this.slotGrid.append(cell);
    }
  }

  private renderKeyboard(): void {
    const snap = app.snapshot;
    if (!snap) return;
    // Only the K1 Pro layout table is ported; other models fall back to
    // the same reference layout the Keys page shows.
    const blocks = K1_PRO_BLOCKS;
    const colors: LightColor[] = this.customColors.map((c, i) => ({
      index: i,
      pos: 8 + i * 4,
      r: c.r,
      g: c.g,
      b: c.b,
    }));
    const km = snap.keymaps.get(app.layer) ?? null;
    if (!this.kbView) {
      this.kbView = new KeyboardView(this.kbHolder, blocks, {
        onKeyClick: (n) => {
          if (n < CUSTOM_LIGHT_SLOTS) this.selectSlot(n);
        },
      });
    }
    this.kbView.setData({ keymap: km, colors });
  }

  // ── JSON ───────────────────────────────────────────────────────────

  /** Resolved apply config — the same JSON shape `light apply` accepts. */
  private resolved(): ResolvedState {
    const snap = app.snapshot;
    const st = snap ? decodeLightState(snap.profile.raw) : null;
    const info = this.modeInfo();
    const colorModel =
      this.colorModel ||
      (info ? info.defaultColorModel : st?.colorModel ?? COLOR_MODEL.MIXING);
    // Only emit `color` when the cmd-10 blob would actually change
    // (skip-unchanged, mirroring `light apply`).
    let group: Rgb | null = null;
    if (
      info?.colorSupport === COLOR_SUPPORT.SINGLE &&
      colorModel === COLOR_MODEL.MONOCHROME &&
      snap
    ) {
      const blob = withGroupColor(snap.lightData, this.mode, this.effectColor);
      if (blob && !bytesEq(blob, snap.lightData)) group = this.effectColor;
    }
    const custom =
      this.customColors.length === CUSTOM_LIGHT_SLOTS &&
      snap &&
      !colorsEqual(
        this.customColors,
        snap.colors.map((c) => ({ r: c.r, g: c.g, b: c.b })),
      )
        ? this.customColors
        : null;
    return {
      mode: this.mode,
      speed: this.speed,
      brightness: this.brightness,
      colorModel,
      groupColor: group,
      customColors: custom,
    };
  }

  private configJson(): string {
    const r = this.resolved();
    const cfg: Record<string, unknown> = { schema: 1 };
    cfg.mode = r.mode;
    cfg.speed = r.speed;
    cfg.brightness = r.brightness;
    cfg.color_model = r.colorModel;
    if (r.groupColor) cfg.color = rgbToHex(r.groupColor);
    if (r.customColors) {
      cfg.keys = { colors: r.customColors.map(rgbToHex) };
    }
    return JSON.stringify(cfg, null, 2);
  }

  private updateJson(): void {
    if (this.jsonPre) this.jsonPre.textContent = this.configJson();
  }

  private downloadJson(): void {
    const blob = new Blob([this.configJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'khub916-light.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Apply ──────────────────────────────────────────────────────────

  /** Confirm dialog: shows the exact JSON + planned writes. */
  private confirmAndApply(): void {
    if (this.applying || !app.connected) return;
    const json = this.configJson();
    const overlay = el('div', 'modal-overlay');
    const modal = el('div', 'modal');
    modal.append(el('h3', '', 'Save these lighting changes?'));
    modal.append(
      el(
        'p',
        'hint',
        'This writes the new effect, colours and speed to the keyboard and ' +
          'checks each step was saved correctly. The keyboard may blink while ' +
          'it updates.',
      ),
    );
    modal.append(el('p', 'hint', 'Exact settings that will be sent:'));
    const pre = el('pre', 'json-view mono', json);
    modal.append(pre);
    const row = el('div', 'light-row');
    const yes = el('button', 'apply-btn', 'Save to keyboard');
    yes.type = 'button';
    const no = el('button', 'segment-item', 'Cancel');
    no.type = 'button';
    row.append(yes, no);
    modal.append(row);
    overlay.append(modal);
    document.body.append(overlay);
    const close = (): void => overlay.remove();
    no.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    yes.addEventListener('click', () => {
      close();
      void this.apply();
    });
  }

  private async apply(): Promise<void> {
    const c = app.connected;
    if (!c) return;
    this.applying = true;
    this.applyBtn.disabled = true;
    this.stepLog.replaceChildren();
    const log = (text: string, cls = ''): void => {
      this.stepLog.append(el('div', `step-line ${cls}`, text));
    };
    try {
      // Fresh reads — SEQUENTIAL: concurrent feature reports poison the
      // session on this firmware (same rule as state.loadSnapshot).
      log('Reading current device state…');
      const profile = await c.session.profile();
      const lightData = await c.session.lightColorData();
      const customNow = await c.session.customLightColors();
      const st = decodeLightState(profile.raw);
      if (!st) throw new Error('profile too short to decode light state');

      const info = this.modeInfo();
      const colorModel = this.colorModel || info?.defaultColorModel || st.colorModel;
      const speed = this.speed;
      const brightness = this.brightness;
      if (speed > 20 || brightness > 20) throw new Error('speed/brightness must be ≤ 20');

      // Profile blob — built BEFORE any write so a bad mode fails early.
      const profileBlob = withLightMode(profile.raw, this.mode, speed, brightness, colorModel);

      // Group colour (cmd 10): monochrome single-colour modes only.
      let newLightBlob: Uint8Array | null = null;
      if (
        info?.colorSupport === COLOR_SUPPORT.SINGLE &&
        colorModel === COLOR_MODEL.MONOCHROME
      ) {
        const blob = withGroupColor(lightData, this.mode, this.effectColor);
        if (!blob) {
          throw new Error(
            `This effect (${this.modeLabel(this.mode)}) does not use a single accent colour.`,
          );
        }
        if (!bytesEq(blob, lightData)) newLightBlob = blob;
      }

      // Custom colours (cmd 6) — skip when unchanged.
      const currentRgb = customNow.map((x) => ({ r: x.r, g: x.g, b: x.b }));
      const customChanged =
        this.customColors.length === CUSTOM_LIGHT_SLOTS &&
        !colorsEqual(this.customColors, currentRgb);

      let failed = false;
      // 1. Per-key colours.
      if (customChanged) {
        try {
          await c.session.writeCustomLightColors(this.customColors);
          log('Key colours: saved and checked', 'ok');
        } catch (e) {
          failed = true;
          log(`Key colours: FAILED — ${msg(e)}`, 'err');
        }
      } else {
        log('Key colours: skipped (unchanged)', 'dim');
      }
      // 2. Effect settings (mode, speed, brightness).
      if (bytesEq(profileBlob, profile.raw)) {
        log('Effect: skipped (unchanged)', 'dim');
      } else {
        try {
          await c.session.writeProfile(profileBlob);
          log('Effect: saved and checked', 'ok');
        } catch (e) {
          failed = true;
          log(`Effect: FAILED — ${msg(e)}`, 'err');
        }
      }
      // 3. Accent colour for single-colour effects.
      if (newLightBlob) {
        try {
          await c.session.writeLightData(newLightBlob);
          log('Effect colour: saved and checked', 'ok');
        } catch (e) {
          failed = true;
          log(`Effect colour: FAILED — ${msg(e)}`, 'err');
        }
      } else {
        log('Effect colour: skipped', 'dim');
      }

      if (failed) {
        setStatus('Some lighting changes failed — see the steps above.', true);
      } else {
        setStatus('Lighting saved to the keyboard.');
        this.dirty = false;
      }
      await refresh();
    } catch (e) {
      setStatus(`Saving failed: ${msg(e)}`, true);
    } finally {
      this.applying = false;
      this.applyBtn.disabled = false;
      this.updateJson();
    }
  }
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Page entry ────────────────────────────────────────────────────────

/**
 * The old Home page folded into here: the connect prompt + first-steps
 * guidance is the lighting page's empty state.
 */
function renderConnectPrompt(root: HTMLElement): void {
  const hero = el('div', 'home-hero');
  hero.append(el('h1', 'home-title', 'Set up your GravaStar keyboard'));
  hero.append(
    el(
      'p',
      'home-note',
      'Change colours and effects, remap keys, record macros — all from ' +
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
    ['2', 'Press "Connect keyboard" and pick it in the browser window.'],
    ['3', 'Pick an effect below — the keyboard shows it live.'],
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
}

let view: LightingView | null = null;

/** Tear down the lighting view (called by the router on destroy). */
export function destroyLightingPage(): void {
  view?.destroy();
  view = null;
}

/** Called by the router on every render pass; cheap when already mounted. */
export function renderLightingPage(root: HTMLElement): void {
  if (!app.connected || !app.snapshot) {
    view?.destroy();
    view = null;
    root.replaceChildren();
    if (app.connected) {
      // Connected but the first read is still in flight.
      const c = card('Lighting');
      c.body.append(el('p', 'hint', 'Reading your keyboard…'));
      root.append(c.card);
      return;
    }
    renderConnectPrompt(root);
    return;
  }
  if (!view) {
    view = new LightingView(root);
    // Warm the current layer so the embedded visualizer has labels.
    void ensureKeymap(app.layer).catch(() => {});
  } else {
    view.syncLive();
  }
}
