/**
 * Lighting scenes (bead nha) — named lighting configs saved as JSON.
 *
 * A scene is exactly the `omg kb916 light apply` config shape produced by
 * the lighting page's settings file (`docs/lighting-schema.md`):
 *
 *   { "schema": 1, "mode": 2, "speed": 8, "brightness": 12,
 *     "color_model": 2, "color": "#rrggbb",
 *     "keys": { "colors": ["#rrggbb", …126 entries…] } }
 *
 * Scenes are stored in `localStorage` (per-browser, offline) and can be
 * exported/imported as `.json` files. "Preview" loads the scene into the
 * lighting editor draft — the keyboard visualiser updates live, but
 * NOTHING is written to the device until the user presses "Save
 * lighting", which runs the existing confirmed apply path (restore-point
 * snapshot → ordered verified writes → stop-on-first-failure, bead 21z).
 *
 * Capability notes (web/src/core/capabilities.ts): khub916 supports
 * per-key RGB (`per_key_rgb`, 126 slots, live-verified on K1 Pro) and the
 * 18-mode effect table with speed/brightness 0–20 — both are captured in
 * a scene. There are no per-zone or conditional (layer/CapsLock/time)
 * lighting primitives on this protocol; scenes are global only. HE v2
 * zone lighting exists in the registry but the web app only speaks
 * khub916 today.
 *
 * The pure functions (parse/serialise/preview/storage) are DOM-free so
 * `scripts/smoke-scenes.ts` can exercise them under plain Node; only the
 * `render*`/`draw*` helpers touch `document`/canvas.
 */

import {
  COLOR_MODEL,
  COLOR_SUPPORT,
  CUSTOM_LIGHT_SLOTS,
  LIGHT_MODES,
  LIGHT_SPECIAL_MODES,
  hsvToRgb,
  lightModeInfo,
  parseColor,
  rgbToHex,
  type Rgb,
} from './proto/light.ts';
import { confirmDialog } from './modal.ts';

// ── Scene config (the `light apply` JSON shape) ────────────────────────

export interface LightingSceneConfig {
  schema: 1;
  /** Wire mode id (profile `raw[9..11]`) — any u16 the firmware knows. */
  mode: number;
  /** Vendor limit 0–20. */
  speed: number;
  /** Vendor limit 0–20. */
  brightness: number;
  /** 1 = monochrome, 2 = colour mixing (single-colour modes only). */
  color_model?: number;
  /** `#rrggbb` accent/colour for single-colour effects (cmd 10). */
  color?: string;
  /** Per-key colours — exactly CUSTOM_LIGHT_SLOTS hex entries (cmd 6). */
  keys?: { colors: string[] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function intIn(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${what}: expected an integer ${lo}–${hi}, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Parse + validate a scene config. Accepts a JSON string or an already
 * parsed object; returns a normalised config (colours canonicalised to
 * `#rrggbb`). Throws `Error` with a user-readable message on bad input.
 */
export function parseSceneConfig(input: unknown): LightingSceneConfig {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      throw new Error(`Scene is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!isObj(raw)) throw new Error('Scene must be a JSON object.');
  if (raw.schema !== undefined && raw.schema !== 1) {
    throw new Error(`Unsupported scene schema ${JSON.stringify(raw.schema)} (want 1).`);
  }
  const mode = intIn(raw.mode, 0, 0xffff, 'mode');
  const speed = intIn(raw.speed, 0, 20, 'speed');
  const brightness = intIn(raw.brightness, 0, 20, 'brightness');

  const cfg: LightingSceneConfig = { schema: 1, mode, speed, brightness };

  if (raw.color_model !== undefined) {
    const cm = intIn(raw.color_model, 1, 2, 'color_model');
    cfg.color_model = cm;
  }
  if (raw.color !== undefined) {
    cfg.color = rgbToHex(parseColor(raw.color, 'color'));
  }
  if (raw.keys !== undefined) {
    if (!isObj(raw.keys) || !Array.isArray(raw.keys.colors)) {
      throw new Error('keys must be an object with a "colors" array.');
    }
    const colors = raw.keys.colors;
    if (colors.length !== CUSTOM_LIGHT_SLOTS) {
      throw new Error(
        `keys.colors must have exactly ${CUSTOM_LIGHT_SLOTS} entries, got ${colors.length}.`,
      );
    }
    cfg.keys = { colors: colors.map((c) => rgbToHex(parseColor(c, 'keys.colors'))) };
  }
  return cfg;
}

/** Canonical pretty-printed JSON for a scene (same shape as the settings file). */
export function sceneConfigToJson(cfg: LightingSceneConfig): string {
  const out: Record<string, unknown> = {
    schema: 1,
    mode: cfg.mode,
    speed: cfg.speed,
    brightness: cfg.brightness,
  };
  if (cfg.color_model !== undefined) out.color_model = cfg.color_model;
  if (cfg.color !== undefined) out.color = cfg.color;
  if (cfg.keys !== undefined) out.keys = { colors: cfg.keys.colors };
  return JSON.stringify(out, null, 2);
}

// ── Human-readable summary + validation hints ──────────────────────────

function modeLabel(id: number): string {
  const name = lightModeInfo(id)?.name ?? `mode ${id}`;
  return name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** One-line summary, e.g. `Breathing · speed 8 · brightness 12`. */
export function sceneSummary(cfg: LightingSceneConfig): string {
  const parts = [`${modeLabel(cfg.mode)}`, `speed ${cfg.speed}`, `brightness ${cfg.brightness}`];
  if (cfg.keys) parts.push('per-key colours');
  else if (cfg.color) parts.push(`colour ${cfg.color}`);
  return parts.join(' · ');
}

/**
 * Non-fatal warnings about what the firmware will actually do with this
 * config — unknown modes, params the effect ignores, colours that only
 * apply to single-colour modes. Empty array = clean.
 */
export function sceneIssues(cfg: LightingSceneConfig): string[] {
  const issues: string[] = [];
  const info = lightModeInfo(cfg.mode);
  if (!info) {
    issues.push(`effect ${cfg.mode} is not in the known 916 mode table`);
  } else {
    if (LIGHT_SPECIAL_MODES.includes(cfg.mode)) {
      issues.push('speed/brightness are ignored by the firmware for this effect');
    }
    if (cfg.color !== undefined && info.colorSupport !== COLOR_SUPPORT.SINGLE) {
      issues.push('the accent colour only applies to single-colour effects');
    }
    if (
      cfg.color_model !== undefined &&
      info.colorSupport !== COLOR_SUPPORT.SINGLE
    ) {
      issues.push('colour style only applies to single-colour effects');
    }
    if (cfg.mode === 0) issues.push('this scene switches the lighting off');
  }
  return issues;
}

// ── Preview ────────────────────────────────────────────────────────────

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const ch = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b) };
}

function hexToRgb(hex: string): Rgb {
  return parseColor(hex, 'preview colour');
}

/**
 * Approximate per-position colours for a scene, `samples` entries across
 * the keyboard. Per-key colours are sampled from the 126-slot table;
 * otherwise the accent colour; otherwise a mode-appropriate stand-in
 * (rainbow for multi-colour effects, neutral for the rest). This is a
 * visual aid only — the device computes the real frame itself.
 */
export function scenePreviewColors(cfg: LightingSceneConfig, samples = 24): Rgb[] {
  const n = Math.max(2, Math.floor(samples));
  if (cfg.keys) {
    const slots = cfg.keys.colors.map(hexToRgb);
    return Array.from({ length: n }, (_, i) => {
      const pos = (i / (n - 1)) * (slots.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(slots.length - 1, lo + 1);
      return lerpRgb(slots[lo]!, slots[hi]!, pos - lo);
    });
  }
  if (cfg.color) {
    const c = hexToRgb(cfg.color);
    return Array.from({ length: n }, () => ({ ...c }));
  }
  const info = lightModeInfo(cfg.mode);
  if (info?.colorSupport === COLOR_SUPPORT.MULTI || info?.colorSupport === COLOR_SUPPORT.CUSTOM) {
    return Array.from({ length: n }, (_, i) => hsvToRgb((i * 360) / n, 1, 1));
  }
  if (info?.colorSupport === COLOR_SUPPORT.OFF || cfg.mode === 0) {
    return Array.from({ length: n }, () => ({ r: 0, g: 0, b: 0 }));
  }
  // Single-colour effect without an explicit colour: show the vendor
  // lime accent as a neutral stand-in for "whatever colour is stored".
  return Array.from({ length: n }, () => ({ r: 0xc6, g: 0xf5, b: 0x4e }));
}

/** CSS `linear-gradient` swatch for scene lists. */
export function sceneSwatchCss(cfg: LightingSceneConfig): string {
  const stops = scenePreviewColors(cfg, 6).map((c) => `rgb(${c.r},${c.g},${c.b})`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * Draw the computed-frame preview into a canvas (browser only). The
 * canvas is treated as 240×28 CSS px; colours are the sampled scene
 * colours. Brightness/speed are reported in the caption, not faked here.
 */
export function drawScenePreview(canvas: HTMLCanvasElement, cfg: LightingSceneConfig): void {
  const w = 240;
  const h = 28;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const colors = scenePreviewColors(cfg, w);
  for (let x = 0; x < w; x++) {
    const c = colors[Math.min(colors.length - 1, Math.floor((x / w) * colors.length))]!;
    ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

// ── localStorage scene store ───────────────────────────────────────────

const STORAGE_KEY = 'omg.lighting-scenes.v1';
const NAME_MAX = 48;

export interface StoredLightingScene {
  name: string;
  savedAt: number;
  config: LightingSceneConfig;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): StoredLightingScene[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: StoredLightingScene[] = [];
    for (const item of raw) {
      if (!isObj(item) || typeof item.name !== 'string') continue;
      try {
        out.push({
          name: item.name,
          savedAt: typeof item.savedAt === 'number' ? item.savedAt : 0,
          config: parseSceneConfig(item.config),
        });
      } catch {
        // Skip corrupt entries rather than losing the whole list.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAll(scenes: StoredLightingScene[]): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(scenes));
  } catch {
    // Quota/serialisation failure — the in-memory list still works.
  }
}

/** All saved scenes, sorted by name. */
export function listScenes(): StoredLightingScene[] {
  return readAll().sort((a, b) => a.name.localeCompare(b.name));
}

export function getScene(name: string): StoredLightingScene | null {
  return readAll().find((s) => s.name === name) ?? null;
}

/** Validate a scene name (used for both the input and imports). */
export function validSceneName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'Give the scene a name.';
  if (n.length > NAME_MAX) return `Scene names are at most ${NAME_MAX} characters.`;
  return null;
}

/** Create or replace a scene by name. Returns the stored record. */
export function saveScene(name: string, config: LightingSceneConfig): StoredLightingScene {
  const problem = validSceneName(name);
  if (problem) throw new Error(problem);
  const n = name.trim();
  const rec: StoredLightingScene = { name: n, savedAt: Date.now(), config };
  const all = readAll().filter((s) => s.name !== n);
  all.push(rec);
  writeAll(all);
  return rec;
}

export function deleteScene(name: string): boolean {
  const all = readAll();
  const next = all.filter((s) => s.name !== name);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

// ── Scene files (.json export/import) ──────────────────────────────────

const FILE_MARKER = 'omg_lighting_scene';

/** Serialise a scene for download — wrapped so imports stay self-describing. */
export function sceneFileText(rec: StoredLightingScene): string {
  return JSON.stringify(
    {
      [FILE_MARKER]: 1,
      name: rec.name,
      saved_at: new Date(rec.savedAt).toISOString(),
      config: JSON.parse(sceneConfigToJson(rec.config)),
    },
    null,
    2,
  );
}

/**
 * Parse a scene file. Accepts the wrapped export format and a bare
 * `light apply` config (schema 1). Returns the config plus the name when
 * the file carries one.
 */
export function parseSceneFile(text: string): { name: string | null; config: LightingSceneConfig } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Scene file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (isObj(raw) && raw[FILE_MARKER] === 1) {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    return { name, config: parseSceneConfig(raw.config) };
  }
  // Bare apply-config — name comes from the file name at the call site.
  return { name: null, config: parseSceneConfig(raw) };
}

/** `omg-lighting-my-scene.json` download name. */
export function sceneFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `omg-lighting-${slug || 'scene'}.json`;
}

// ── Scenes card (browser DOM) ──────────────────────────────────────────

/**
 * The slice of the lighting page the scenes card needs: read the current
 * draft as JSON and load a scene back into it. `LightingView` satisfies
 * this structurally.
 */
export interface LightingSceneHost {
  /** Current editor draft as canonical scene/settings JSON. */
  currentSceneJson(): string;
  /** Load a scene JSON into the editor draft (preview only — no device write). */
  loadSceneJson(json: string): void;
}

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

/**
 * Build the "Scenes" card for the lighting page. Renders the saved-scene
 * list with swatch previews, a save-current row, JSON import/export and
 * a computed-frame preview canvas for the selected scene.
 */
export function renderScenesSection(host: LightingSceneHost): HTMLElement {
  const card = el('section', 'card');
  card.append(el('h2', '', 'Scenes'));
  const body = el('div', 'card-body');
  card.append(body);

  body.append(
    el(
      'p',
      'hint',
      'Save the current effect, colours and speed as a named scene. ' +
        'Previewing a scene only changes the editor — the keyboard is ' +
        'written when you press "Save lighting" below.',
    ),
  );

  // Save-current + import row.
  const saveRow = el('div', 'light-row');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'scene-name mono';
  nameInput.maxLength = NAME_MAX;
  nameInput.placeholder = 'Scene name';
  nameInput.setAttribute('aria-label', 'Scene name');
  const saveBtn = el('button', 'btn', 'Save current as scene');
  saveBtn.type = 'button';
  const importBtn = el('button', 'btn', 'Import .json');
  importBtn.type = 'button';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  saveRow.append(nameInput, saveBtn, importBtn, fileInput);
  body.append(saveRow);

  const status = el('p', 'hint scene-status', '');
  body.append(status);

  // Preview canvas + caption for the selected scene.
  const previewRow = el('div', 'scene-preview-row');
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-preview';
  canvas.width = 240;
  canvas.height = 28;
  const meta = el('div', 'scene-preview-meta');
  const metaTitle = el('div', 'scene-preview-title', 'Select a scene to preview');
  const metaSub = el('div', 'scene-preview-sub hint', '');
  meta.append(metaTitle, metaSub);
  previewRow.append(canvas, meta);
  body.append(previewRow);

  const list = el('div', 'scene-list');
  body.append(list);

  let selected: string | null = null;

  const showPreview = (rec: StoredLightingScene): void => {
    selected = rec.name;
    drawScenePreview(canvas, rec.config);
    metaTitle.textContent = rec.name;
    const issues = sceneIssues(rec.config);
    metaSub.textContent =
      sceneSummary(rec.config) +
      (issues.length ? ` — note: ${issues.join('; ')}` : '');
    for (const row of list.querySelectorAll<HTMLElement>('.scene-row')) {
      row.classList.toggle('selected', row.dataset.name === rec.name);
    }
  };

  const clearPreview = (): void => {
    selected = null;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#101314';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    metaTitle.textContent = 'Select a scene to preview';
    metaSub.textContent = '';
    for (const row of list.querySelectorAll<HTMLElement>('.scene-row')) {
      row.classList.remove('selected');
    }
  };

  const refresh = (): void => {
    list.replaceChildren();
    const scenes = listScenes();
    if (scenes.length === 0) {
      list.append(el('p', 'hint', 'No saved scenes yet — adjust the lighting above, name it, and press "Save current as scene".'));
      clearPreview();
      return;
    }
    for (const rec of scenes) {
      const row = el('div', 'scene-row');
      row.dataset.name = rec.name;
      const swatch = el('span', 'scene-swatch');
      swatch.style.background = sceneSwatchCss(rec.config);
      const info = el('div', 'scene-info');
      info.append(el('div', 'scene-title', rec.name), el('div', 'scene-meta', sceneSummary(rec.config)));
      const actions = el('div', 'scene-actions');

      const previewBtn = el('button', 'btn', 'Preview');
      previewBtn.type = 'button';
      previewBtn.title = 'Load into the editor — press "Save lighting" to write it';
      previewBtn.addEventListener('click', () => {
        try {
          host.loadSceneJson(sceneConfigToJson(rec.config));
          showPreview(rec);
          status.textContent = `"${rec.name}" loaded into the editor — press "Save lighting" to write it to the keyboard.`;
        } catch (e) {
          status.textContent = `Could not load "${rec.name}": ${msg(e)}`;
        }
      });

      const jsonBtn = el('button', 'btn', 'JSON');
      jsonBtn.type = 'button';
      jsonBtn.title = 'Download this scene as a .json file';
      jsonBtn.addEventListener('click', () => downloadScene(rec));

      const delBtn = el('button', 'btn', 'Delete');
      delBtn.type = 'button';
      delBtn.addEventListener('click', () => {
        void confirmDialog({
          title: `Delete scene "${rec.name}"?`,
          bodyText: 'This only removes the saved scene from this browser — the keyboard is not changed.',
          confirmLabel: 'Delete',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          deleteScene(rec.name);
          if (selected === rec.name) clearPreview();
          refresh();
          status.textContent = `Scene "${rec.name}" deleted.`;
        });
      });

      actions.append(previewBtn, jsonBtn, delBtn);
      row.append(swatch, info, actions);
      info.addEventListener('click', () => showPreview(rec));
      row.addEventListener('click', (e) => {
        if (e.target === row || e.target === swatch || e.target === info) showPreview(rec);
      });
      list.append(row);
    }
    if (selected) {
      const still = scenes.find((s) => s.name === selected);
      if (still) showPreview(still);
      else clearPreview();
    } else {
      clearPreview();
    }
  };

  const downloadScene = (rec: StoredLightingScene): void => {
    const blob = new Blob([sceneFileText(rec)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sceneFileName(rec.name);
    a.click();
    URL.revokeObjectURL(a.href);
  };

  saveBtn.addEventListener('click', () => {
    try {
      const cfg = parseSceneConfig(host.currentSceneJson());
      const rec = saveScene(nameInput.value, cfg);
      nameInput.value = '';
      refresh();
      showPreview(rec);
      status.textContent = `Scene "${rec.name}" saved.`;
    } catch (e) {
      status.textContent = `Could not save the scene: ${msg(e)}`;
    }
  });

  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void file.text().then((text) => {
      try {
        const { name, config } = parseSceneFile(text);
        const fallback = file.name.replace(/\.json$/i, '');
        const rec = saveScene(name ?? fallback, config);
        refresh();
        showPreview(rec);
        status.textContent = `Scene "${rec.name}" imported.`;
      } catch (e) {
        status.textContent = `Could not import the scene file: ${msg(e)}`;
      }
    });
  });

  refresh();
  return card;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
