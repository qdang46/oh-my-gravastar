/**
 * Secondary pages for the khub916 configurator shell (bead jwb, P3).
 *
 * Vendor menu entries covered here (docs/web-ui-plan.md §2/§3):
 *   basicFunctions          → `basic`   (keycap/layout editor — vendor
 *                             persists it in browser storage only; the
 *                             `update:keyboard` handler is a no-op, so
 *                             nothing is ever written to the device)
 *   configurationManagement → `config`  (named config slots + JSON
 *                             import/export; we implement the device
 *                             profile export/import as schema-v1 JSON,
 *                             mirroring `omg profile export|import`)
 *   rhythm                  → `rhythm`  (MusicMAxisPlug companion — out
 *                             of scope per plan §3; stub with facts)
 *   setting                 → `setting` (vendor page is an empty
 *                             placeholder; we surface the one writable
 *                             setting the protocol exposes: sleep time)
 *
 * Device overview lives on the existing `device` page in pages.ts; this
 * module also owns `snapshotToJson()` / `buildProfileExport()` which the
 * device page reuses for its JSON view.
 *
 * DOM helpers are duplicated from pages.ts on purpose: this file must
 * stay self-contained so concurrent page work does not conflict.
 */

import { app, refresh, setStatus, subscribe, type DeviceSnapshot } from './state.ts';
import { profileWithSleepSeconds } from './proto/khub916.ts';
import { K1_PRO_BLOCKS, K1_PRO_LAYOUT_MODELS } from './k1pro-layout.ts';
import { t } from './i18n.ts';

// ── DOM helpers (mirror pages.ts) ──────────────────────────────────────

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
  body.append(el('p', 'coming-soon', t('common.comingSoon')));
  body.append(el('p', 'hint', blurb));
  if (facts.length) {
    const ul = el('ul', 'fact-list');
    for (const f of facts) ul.append(el('li', '', f));
    body.append(ul);
  }
  return c;
}

function disconnectedCard(title: string, blurb: string): HTMLElement {
  const { card: c, body } = card(title);
  body.append(el('p', 'hint', blurb));
  body.append(el('p', 'hint warn', t('common.connectFirst')));
  return c;
}

// ── Shared JSON helpers ────────────────────────────────────────────────

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim();
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Pretty JSON of everything the snapshot already holds — used by the
 * Device page's "Snapshot JSON" view.
 */
export function snapshotToJson(snap: DeviceSnapshot): string {
  const doc = {
    device_info: {
      uuid: snap.info.uuid,
      version: snap.info.versionHex,
      screen_size: snap.info.screenSize,
      screen: snap.info.screen,
      catalog_model: snap.info.catalogModel,
      catalog_name: snap.info.catalogName,
    },
    power: { percent: snap.power.percent, flags: `0x${snap.power.flags.toString(16).padStart(2, '0')}` },
    profile: {
      bytes: snap.profile.raw.length,
      light_mode: snap.profile.lightMode,
      sleep_seconds: snap.profile.sleepSeconds,
      hex: bytesToHex(snap.profile.raw),
    },
    light_colors: snap.colors.map((c) => ({ index: c.index, pos: c.pos, r: c.r, g: c.g, b: c.b })),
    light_data_bytes: snap.lightData.length,
    light_data_hex: bytesToHex(snap.lightData),
    macro_bytes: snap.macro.length,
    macro_hex: bytesToHex(snap.macro),
    keymaps_cached: [...snap.keymaps.entries()].map(([arg, keys]) => ({
      arg,
      entries: keys.length,
    })),
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Build a schema-v1 profile document for the connected khub916 device —
 * the web counterpart of `omg profile export --full` (crates/omg
 * profile.rs `khub916_state`). Reads keymaps for args 0–7 on demand;
 * per-section read failures land as `{"error": …}` like the Rust `sec()`.
 */
export async function buildProfileExport(): Promise<Record<string, unknown>> {
  const c = app.connected;
  const snap = app.snapshot;
  if (!c || !snap) throw new Error(t('config.errConnectFirst'));

  const sec = async <T>(fn: () => Promise<T>): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const keymap: Record<string, unknown> = {};
  for (let arg = 0; arg < 8; arg++) {
    keymap[String(arg)] = await sec(async () =>
      (await c.session.keyValues(arg)).map(
        (v) => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
      ),
    );
  }

  const state = {
    device_info: await sec(async () => {
      const i = snap.info;
      return {
        uuid: i.uuid,
        version: i.versionHex,
        screen_size: i.screenSize,
        screen: i.screen,
        catalog_model: i.catalogModel,
        catalog_name: i.catalogName,
      };
    }),
    keymap,
    profile: {
      bytes: snap.profile.raw.length,
      light_mode: snap.profile.lightMode,
      sleep_seconds: snap.profile.sleepSeconds,
      hex: bytesToHex(snap.profile.raw),
    },
    power: { percent: snap.power.percent, flags: snap.power.flags },
    light_colors: snap.colors.map((col) => ({
      index: col.index,
      pos: col.pos,
      r: col.r,
      g: col.g,
      b: col.b,
    })),
    light_data_hex: bytesToHex(snap.lightData),
    macro_hex: bytesToHex(snap.macro),
  };

  const coll = c.collection;
  return {
    schema: 1,
    exported_at: new Date().toISOString(),
    host: 'omg-web',
    devices: [
      {
        protocol: 'khub916',
        vid: c.device.vendorId,
        pid: c.device.productId,
        usage_page: coll.usagePage,
        usage: coll.usage,
        model: snap.info.catalogName ?? c.device.productName ?? 'unknown',
        profiles: [{ name: 'current', state }],
      },
    ],
  };
}

// ── Config import (schema-v1 → device writes) ──────────────────────────

interface ImportSection {
  name: string;
  /** Human-readable summary shown in the preview. */
  summary: string;
  /** Apply this section; returns a result line. */
  apply: () => Promise<string>;
}

export interface ParsedImport {
  fileName: string;
  model: string;
  sections: ImportSection[];
  skipped: string[];
}

const HEX_U32 = /^0x[0-9a-fA-F]{8}$/;

// ── Write-path capability detection ────────────────────────────────────
//
// The khub916 write methods (`writeProfile`, `writeKeymap`, …) land on
// `Khub916Session` with the lighting/keys/macro beads (hid.ts). This page
// is committed independently, so every write goes through this optional
// interface: when a method is absent the section is reported as "pending"
// instead of failing the build or the import.

interface WriteOutcome {
  command: number;
  verified: boolean;
}

interface KhubWrites {
  writeProfile?(blob: Uint8Array): Promise<WriteOutcome>;
  writeKeymap?(layer: number, system: number, values: readonly number[]): Promise<WriteOutcome>;
  writeCustomLightColors?(
    colors: readonly { r: number; g: number; b: number }[],
  ): Promise<WriteOutcome>;
  writeLightData?(data: Uint8Array): Promise<WriteOutcome>;
  writeMacroRegion?(data: Uint8Array): Promise<WriteOutcome>;
}

function sessionWrites(session: unknown): KhubWrites {
  return session as KhubWrites;
}

const PENDING = t('config.pending');

/**
 * Parse a schema-v1 profile file and turn its khub916 `state` into the
 * list of writable sections. Sections with no verified write path (the
 * raw profile blob — same export-only stance as `omg profile import`)
 * are reported in `skipped`, never silently dropped.
 */
export function parseProfileImport(text: string, fileName: string): ParsedImport {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (doc.schema !== 1) {
    throw new Error(t('config.errNotProfile'));
  }
  const devices = doc.devices;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(t('config.errNotBackup'));
  }
  const dev = devices.find(
    (d) => (d as Record<string, unknown>).protocol === 'khub916',
  ) as Record<string, unknown> | undefined;
  if (!dev) throw new Error(t('config.errNoKhub'));

  const profiles = dev.profiles;
  const prof = (Array.isArray(profiles) ? profiles : []).find(
    (p) => (p as Record<string, unknown>).name === 'current',
  ) as Record<string, unknown> | undefined;
  const state = (prof?.state ??
    (Array.isArray(profiles) ? (profiles[0] as Record<string, unknown>)?.state : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (!state || typeof state !== 'object') {
    throw new Error(t('config.errNoSettings'));
  }

  const c = app.connected;
  const snap = app.snapshot;
  if (!c || !snap) throw new Error(t('config.errConnectFirst'));
  const w = sessionWrites(c.session);
  const sections: ImportSection[] = [];
  const skipped: string[] = [];

  // ── Keymap (cmd 3 writes, args 0–7 = layer | system<<2) ──
  const km = state.keymap;
  if (km && typeof km === 'object' && !Array.isArray(km)) {
    const jobs: { arg: number; values: number[] }[] = [];
    for (const [argStr, raw] of Object.entries(km as Record<string, unknown>)) {
      const arg = Number(argStr);
      if (!Number.isInteger(arg) || arg < 0 || arg > 7) continue;
      if (!Array.isArray(raw)) {
        skipped.push(t('config.layerUnreadable', { n: argStr }));
        continue;
      }
      const values: number[] = [];
      let bad = false;
      for (const v of raw) {
        if (typeof v === 'string' && HEX_U32.test(v)) {
          values.push(parseInt(v.slice(2), 16) >>> 0);
        } else if (typeof v === 'number' && Number.isInteger(v)) {
          values.push(v >>> 0);
        } else {
          bad = true;
          break;
        }
      }
      if (bad || values.length === 0) {
        skipped.push(t('config.layerUnreadableVals', { n: argStr }));
        continue;
      }
      jobs.push({ arg, values });
    }
    if (jobs.length) {
      if (!w.writeKeymap) {
        skipped.push(t('config.pendingLayers', { n: jobs.length, why: PENDING }));
      } else {
        const writeKeymap = w.writeKeymap.bind(c.session);
        sections.push({
          name: t('config.keymapSection'),
          summary: t('config.keymapSummary', { n: jobs.length }),
          apply: async () => {
            const done: string[] = [];
            for (const j of jobs) {
              const out = await writeKeymap(j.arg & 3, (j.arg >> 2) & 1, j.values);
              done.push(`${t('config.keymapSaved', { n: j.arg & 3 })}${out.verified ? ' ✓' : ''}`);
            }
            return t('config.savedList', { list: done.join(', ') });
          },
        });
      }
    }
  }

  // ── Custom light colours (cmd 6, needs all 126 slots) ──
  const lc = state.light_colors;
  if (Array.isArray(lc) && lc.length > 0) {
    const byIndex = new Map<number, { r: number; g: number; b: number }>();
    let bad = false;
    for (const e of lc) {
      const o = e as Record<string, unknown>;
      const i = o.index;
      const r = o.r;
      const g = o.g;
      const b = o.b;
      if (
        typeof i !== 'number' ||
        typeof r !== 'number' ||
        typeof g !== 'number' ||
        typeof b !== 'number' ||
        r < 0 ||
        r > 255 ||
        g < 0 ||
        g > 255 ||
        b < 0 ||
        b > 255
      ) {
        bad = true;
        break;
      }
      byIndex.set(i, { r: r & 0xff, g: g & 0xff, b: b & 0xff });
    }
    // Fill gaps from the live snapshot so the 126-slot payload stays sane.
    const colors: { r: number; g: number; b: number }[] = [];
    let complete = !bad;
    for (let i = 0; i < 126; i++) {
      const col = byIndex.get(i) ?? snap.colors[i];
      if (!col) {
        complete = false;
        break;
      }
      colors.push({ r: col.r, g: col.g, b: col.b });
    }
    if (complete) {
      if (!w.writeCustomLightColors) {
        skipped.push(t('config.pendingColors', { n: byIndex.size, why: PENDING }));
      } else {
        const writeColors = w.writeCustomLightColors.bind(c.session);
        sections.push({
          name: t('config.colorsSection'),
          summary: t('config.colorsSummary', { n: byIndex.size }),
          apply: async () => {
            const out = await writeColors(colors);
            return out.verified ? t('config.savedChecked') : t('config.saved');
          },
        });
      }
    } else {
      skipped.push(t('config.skipColorsBad'));
    }
  }

  // ── Per-mode light data (wired cmd 10) ──
  const ld = state.light_data_hex;
  if (typeof ld === 'string' && ld.length > 0) {
    const bytes = hexToBytes(ld);
    if (bytes && bytes.length > 0) {
      if (!w.writeLightData) {
        skipped.push(t('config.pendingLight', { n: bytes.length, why: PENDING }));
      } else {
        const writeLightData = w.writeLightData.bind(c.session);
        sections.push({
          name: t('config.lightSection'),
          summary: t('config.lightSummary', { n: bytes.length }),
          apply: async () => {
            const out = await writeLightData(bytes);
            return out.verified ? t('config.savedChecked') : t('config.saved');
          },
        });
      }
    } else {
      skipped.push(t('config.skipLightBad'));
    }
  }

  // ── Macro region (cmd 5) ──
  const mx = state.macro_hex;
  if (typeof mx === 'string' && mx.length > 0) {
    const bytes = hexToBytes(mx);
    if (bytes && bytes.length > 0 && bytes.length <= 512) {
      if (!w.writeMacroRegion) {
        skipped.push(t('config.pendingMacro', { n: bytes.length, why: PENDING }));
      } else {
        const writeMacro = w.writeMacroRegion.bind(c.session);
        sections.push({
          name: t('config.macroSection'),
          summary: t('config.macroSummary', { n: bytes.length }),
          apply: async () => {
            const out = await writeMacro(bytes);
            return out.verified ? t('config.savedChecked') : t('config.saved');
          },
        });
      }
    } else {
      skipped.push(t('config.skipMacroBad'));
    }
  }

  // ── Profile blob: export-only, same as `omg profile import` ──
  if (state.profile && typeof state.profile === 'object') {
    const p = state.profile as Record<string, unknown>;
    skipped.push(t('config.skipProfile'));
  }

  return {
    fileName,
    model: String(dev.model ?? 'unknown'),
    sections,
    skipped,
  };
}

// ── Page: Basic functions (vendor basicFunctions / keyCodeMove) ────────

function renderBasic(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    root.append(
      disconnectedCard(t('basic.title'), t('basic.disconnectedBlurb')),
    );
    return;
  }

  const model = app.snapshot.info.catalogModel;
  // Only the K1 Pro table is ported (k1pro-layout.ts); other models fall
  // back to it — the kv row below says so.
  const blocks = K1_PRO_BLOCKS;
  const physical = blocks.filter((b) => b.display);
  const hidden = blocks.length - physical.length;

  const c = card(t('basic.title'));
  const dl = el('dl', 'kv');
  kv(dl, t('basic.kvKeys'), t('basic.keysCount', { n: physical.length }));
  kv(dl, t('basic.kvKeySize'), t('basic.keySize'));
  kv(
    dl,
    t('basic.layoutTable'),
    model && K1_PRO_LAYOUT_MODELS.includes(model)
      ? t('basic.layoutMatched')
      : t('basic.layoutGeneric'),
  );
  kv(dl, t('basic.kvLivePreview'), t('basic.livePreview'));
  c.body.append(dl);

  c.body.append(el('p', 'hint', t('basic.hint')));

  const disabled = el('div', 'sec-actions');
  const mkBtn = (label: string, reason: string): void => {
    const b = el('button', 'sec-btn', label);
    b.type = 'button';
    b.disabled = true;
    b.title = reason;
    disabled.append(b);
  };
  mkBtn(t('basic.editKeyShape'), t('basic.editKeyShapeWhy'));
  mkBtn(t('basic.hiddenKeys'), t('basic.hiddenKeysWhy'));
  mkBtn(t('basic.baseSize'), t('basic.baseSizeWhy'));
  c.body.append(disabled);
  root.append(c.card);
}

// ── Page: Configuration management ─────────────────────────────────────

let importPreview: ParsedImport | null = null;
let importConfirm = false;
let importBusy = false;
let importLog: string[] = [];

function renderConfig(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    importPreview = null;
    importConfirm = false;
    importBusy = false;
    importLog = [];
    root.append(
      disconnectedCard(t('config.title'), t('config.disconnectedBlurb')),
    );
    return;
  }

  // ── Export ──
  const ex = card(t('config.exportTitle'));
  ex.body.append(el('p', 'hint', t('config.exportHint')));
  const exBtn = el('button', 'sec-btn', t('config.downloadBtn'));
  exBtn.type = 'button';
  exBtn.disabled = app.busy;
  exBtn.addEventListener('click', () => {
    void (async () => {
      exBtn.disabled = true;
      exBtn.textContent = t('config.reading');
      try {
        const doc = await buildProfileExport();
        const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], {
          type: 'application/json',
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `omg-khub916-${stamp}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        setStatus(t('config.downloaded'));
      } catch (e) {
        setStatus(t('config.exportFailed', { msg: e instanceof Error ? e.message : String(e) }), true);
      } finally {
        exBtn.disabled = false;
        exBtn.textContent = t('config.downloadBtn');
      }
    })();
  });
  ex.body.append(exBtn);
  root.append(ex.card);

  // ── Import ──
  const im = card(t('config.importTitle'));
  im.body.append(el('p', 'hint', t('config.importHint')));

  const fileInput = el('input', 'sec-file');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    importPreview = null;
    importConfirm = false;
    if (!f) {
      renderConfig(root);
      return;
    }
    void f.text().then(
      (text) => {
        try {
          importPreview = parseProfileImport(text, f.name);
        } catch (e) {
          importPreview = null;
          importLog = [t('config.fileBad', { msg: e instanceof Error ? e.message : String(e) })];
        }
        renderConfig(root);
      },
      (e) => {
        importLog = [t('config.fileUnreadable', { msg: e instanceof Error ? e.message : String(e) })];
        renderConfig(root);
      },
    );
  });
  im.body.append(fileInput);

  if (importLog.length) {
    const pre = el('pre', 'sec-log');
    pre.textContent = importLog.join('\n');
    im.body.append(pre);
  }

  if (importPreview) {
    const p = importPreview;
    im.body.append(el('p', 'hint', t('config.fileLine', { name: p.fileName, model: p.model })));
    if (p.sections.length === 0) {
      im.body.append(el('p', 'hint warn', t('config.noWritable')));
    } else {
      const ul = el('ul', 'fact-list');
      for (const s of p.sections) ul.append(el('li', '', `${s.name}: ${s.summary}`));
      im.body.append(ul);
      const applyBtn = el(
        'button',
        'sec-btn sec-btn-danger',
        importConfirm
          ? t('config.writeBtnConfirm', { n: p.sections.length })
          : t('config.writeBtn'),
      );
      applyBtn.type = 'button';
      applyBtn.disabled = importBusy || app.busy;
      applyBtn.addEventListener('click', () => {
        if (!importConfirm) {
          importConfirm = true;
          renderConfig(root);
          return;
        }
        const sections = p.sections;
        importBusy = true;
        importConfirm = false;
        importLog = [];
        renderConfig(root);
        void (async () => {
          const results: string[] = [];
          try {
            for (const s of sections) {
              results.push(`${s.name}: ${await s.apply()}`);
            }
            results.push(t('config.allSaved'));
            await refresh();
          } catch (e) {
            results.push(t('config.failed', { msg: e instanceof Error ? e.message : String(e) }));
          } finally {
            importBusy = false;
            importPreview = null;
            importLog = results;
            renderConfig(root);
          }
        })();
      });
      im.body.append(applyBtn);
      im.body.append(
        el('p', 'hint warn', t('config.writeWarn')),
      );
    }
    if (p.skipped.length) {
      const ul = el('ul', 'fact-list');
      for (const s of p.skipped) ul.append(el('li', '', t('config.skippedPrefix', { what: s })));
      im.body.append(ul);
    }
  }
  root.append(im.card);
}

// ── Page: Rhythm (vendor rhythm — MusicMAxisPlug companion) ────────────

function renderRhythm(root: HTMLElement): void {
  root.replaceChildren();
  root.append(
    comingSoon(t('rhythm.title'), t('rhythm.blurb'), [t('rhythm.fact1'), t('rhythm.fact2')]),
  );
}

// ── Page: Setting (vendor setting — empty placeholder upstream) ────────

let sleepInput = '';
let sleepConfirm = false;
let sleepBusy = false;
let sleepLog: string[] = [];

function renderSetting(root: HTMLElement): void {
  root.replaceChildren();
  if (!app.connected || !app.snapshot) {
    sleepInput = '';
    sleepConfirm = false;
    sleepBusy = false;
    sleepLog = [];
    root.append(
      disconnectedCard(t('setting.title'), t('setting.disconnectedBlurb')),
    );
    return;
  }

  const snap = app.snapshot;
  const current = snap.profile.sleepSeconds;

  const c = card(t('setting.sleepTitle'));
  const dl = el('dl', 'kv');
  kv(dl, t('setting.sleepCurrent'), current !== null ? t('setting.sleepSeconds', { n: current }) : '—');
  kv(dl, t('setting.sleepWhat'), t('setting.sleepWhatText'));
  kv(dl, t('setting.sleepNote'), t('setting.sleepNoteText'));
  c.body.append(dl);

  const row = el('div', 'sec-actions');
  const input = el('input', 'sec-input');
  input.type = 'number';
  input.min = '0';
  input.max = '255';
  input.step = '1';
  input.placeholder = current !== null ? String(current) : t('setting.secondsPlaceholder');
  input.value = sleepInput || (current !== null ? String(current) : '');
  input.addEventListener('input', () => {
    sleepInput = input.value;
  });
  row.append(input);

  const applyBtn = el(
    'button',
    'sec-btn sec-btn-danger',
    sleepConfirm ? t('setting.confirmSleep') : t('setting.setSleep'),
  );
  applyBtn.type = 'button';
  applyBtn.disabled = sleepBusy || app.busy;
  applyBtn.addEventListener('click', () => {
    const seconds = Number(input.value);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 255) {
      sleepLog = [t('setting.badSeconds')];
      renderSetting(root);
      return;
    }
    if (!sleepConfirm) {
      sleepConfirm = true;
      renderSetting(root);
      return;
    }
    sleepBusy = true;
    sleepConfirm = false;
    sleepLog = [];
    renderSetting(root);
    void (async () => {
      const session = app.connected?.session;
      const writeProfile = session ? sessionWrites(session).writeProfile : undefined;
      if (!session || !writeProfile) {
        sleepBusy = false;
        sleepLog = [t('setting.sleepPending', { why: PENDING })];
        renderSetting(root);
        return;
      }
      try {
        const prof = await session.profile();
        const blob = profileWithSleepSeconds(prof.raw, seconds);
        const out = await writeProfile.call(session, blob);
        sleepInput = '';
        await refresh();
        sleepLog = [
          out.verified
            ? t('setting.sleepSaved', { n: seconds })
            : t('setting.sleepSent', { n: seconds }),
        ];
      } catch (e) {
        sleepLog = [t('setting.sleepFailed', { msg: e instanceof Error ? e.message : String(e) })];
      } finally {
        sleepBusy = false;
        renderSetting(root);
      }
    })();
  });
  row.append(applyBtn);
  c.body.append(row);

  if (sleepLog.length) {
    const pre = el('pre', 'sec-log');
    pre.textContent = sleepLog.join('\n');
    c.body.append(pre);
  }
  root.append(c.card);

  const facts = card(t('setting.otherTitle'));
  const ul = el('ul', 'fact-list');
  ul.append(
    el('li', '', t('setting.factLight')),
    el('li', '', t('setting.factDevice')),
    el('li', '', t('setting.factKeys')),
    el('li', '', t('setting.factSafety')),
  );
  facts.body.append(ul);
  root.append(facts.card);
}

// ── Registry ───────────────────────────────────────────────────────────

export type SecondaryPageId = 'basic' | 'config' | 'rhythm' | 'setting';

export const SECONDARY_PAGES: readonly { id: SecondaryPageId; path: string; title: string }[] = [
  { id: 'basic', path: '/basic', title: 'Layout' },
  { id: 'config', path: '/config', title: 'Backup' },
  { id: 'rhythm', path: '/rhythm', title: 'Music' },
  { id: 'setting', path: '/setting', title: 'Settings' },
] as const;

export const SECONDARY_RENDERERS: Record<SecondaryPageId, (root: HTMLElement) => void> = {
  basic: renderBasic,
  config: renderConfig,
  rhythm: renderRhythm,
  setting: renderSetting,
};

// Clear module state when the device disconnects.
subscribe(() => {
  if (!app.connected) {
    importPreview = null;
    importConfirm = false;
    importBusy = false;
    importLog = [];
    sleepInput = '';
    sleepConfirm = false;
    sleepBusy = false;
    sleepLog = [];
  }
});
