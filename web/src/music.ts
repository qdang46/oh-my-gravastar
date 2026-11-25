/**
 * Music page — mic-reactive keyboard lighting via khub916 cmd-8 frame
 * streaming (bead oh-my-gravastar-8r8).
 *
 * Pipeline mirrors `omg kb916 light music` (crates/omg/src/kb916_music.rs)
 * and the `omg-music` crate, adapted to the browser:
 *
 *   getUserMedia({audio}) → AudioContext → AnalyserNode(fftSize 2048)
 *   → getByteFrequencyData → MusicAnalyzer (log bands + beat)
 *   → SpectrumViz → 378-byte interleaved frame → session.writeGifFrame
 *   at ~30 ms pacing (GIF_FRAME_PERIOD_MS).
 *
 * The same page also hosts **pixel art** (proto/pixelart.ts, port of
 * crates/music/src/pixelart.rs): text/bitmap → per-slot RGB → the same
 * cmd-8 stream, no microphone involved.
 *
 * Restore contract (same as the CLI): on start we snapshot the profile
 * blob (cmd 132) and the per-mode light-data blob (cmd 138); on stop —
 * user, navigation, or disconnect — we write both back with the same
 * verified `writeProfile`/`writeLightData` paths the Lighting page uses.
 *
 * Only the microphone is available in a browser page (no system audio);
 * the UI says so plainly.
 */

import { app, emit, setStatus, subscribe } from './state.ts';
import { K1_PRO_BLOCKS, keyIndexOf } from './k1pro-layout.ts';
import {
  PixelArt,
  RGB_WHITE,
  type KeyPoint,
  type Motion,
  type PaletteName,
  type Rgb,
} from './proto/pixelart.ts';
import {
  DEFAULT_FRAME_PARAMS,
  GIF_FRAME_BYTES,
  GIF_FRAME_PERIOD_MS,
  KEY_SLOTS,
  MusicAnalyzer,
  SpectrumViz,
  silentBands,
  type Bands,
  type FrameParams,
} from './proto/music.ts';

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface AudioRig {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
}

/**
 * Per-slot key geometry for the pixel-art engine: slot `n` (keymap
 * index, `pos = 8 + n*4`) → physical key centre in px from the vendor
 * layout table. Non-physical slots (`display:false`) get a linear
 * spread like the Rust engine's unplaceable fallback.
 */
function k1proGeometry(): KeyPoint[] {
  const pts: (KeyPoint | null)[] = new Array(KEY_SLOTS).fill(null);
  for (const b of K1_PRO_BLOCKS) {
    const n = keyIndexOf(b.pos);
    if (n < 0 || n >= KEY_SLOTS) continue;
    pts[n] = b.display
      ? { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      : null;
  }
  return pts.map((p, i) => p ?? { x: (i / (KEY_SLOTS - 1)) * 16.5, y: 3 });
}

/** Float32 RGB triples (0..1) → 378-byte interleaved cmd-8 payload. */
function packPixelFrame(rgb: Float32Array): Uint8Array {
  const out = new Uint8Array(GIF_FRAME_BYTES);
  const n = Math.min(KEY_SLOTS, Math.floor(rgb.length / 3));
  for (let i = 0; i < n; i++) {
    out[i * 3] = Math.min(255, Math.max(0, Math.round((rgb[i * 3] ?? 0) * 255)));
    out[i * 3 + 1] = Math.min(
      255,
      Math.max(0, Math.round((rgb[i * 3 + 1] ?? 0) * 255)),
    );
    out[i * 3 + 2] = Math.min(
      255,
      Math.max(0, Math.round((rgb[i * 3 + 2] ?? 0) * 255)),
    );
  }
  return out;
}

/** Float RGB (0..1) → `#rrggbb` for the colour picker. */
function rgbToHex(c: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

/** What the stream saved so stop() can put the lighting back. */
interface SavedLighting {
  profile: Uint8Array;
  lightData: Uint8Array;
}

export class MusicPage {
  readonly el: HTMLElement;

  private running = false;
  /** True during the async mic+snapshot phase before streaming begins. */
  private starting = false;
  /** Set by stop() while start() is still in its async setup phase. */
  private stopRequested = false;
  private pumpDone: Promise<void> | null = null;
  /** Dedupes the restore path shared by pump-exit and stop(). */
  private finishPromise: Promise<void> | null = null;
  /** Set by stop({restore:false}) before the pump finishes. */
  private wantRestore = true;
  private rig: AudioRig | null = null;
  private analyzer: MusicAnalyzer | null = null;
  private viz = new SpectrumViz();
  private params: FrameParams = { ...DEFAULT_FRAME_PARAMS };
  private bands: Bands = silentBands();
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private saved: SavedLighting | null = null;
  private framesSent = 0;
  private startedAt = 0;

  // Pixel-art stream (no mic needed — same cmd-8 path as music mode).
  private pixelRunning = false;
  private pixelStarting = false;
  private pixelStopRequested = false;
  private pixelPumpDone: Promise<void> | null = null;
  private pixelFinishPromise: Promise<void> | null = null;
  private pixelWantRestore = true;
  private pixelViz: PixelArt | null = null;
  private pixelSaved: SavedLighting | null = null;
  private pixelFramesSent = 0;
  private pixelStartedAt = 0;
  private pixelText = 'OMG';
  private pixelMotion: Motion = 'scroll_left';
  private pixelPalette: PaletteName | null = null;
  private pixelColor: Rgb = { ...RGB_WHITE };
  private pixelSpeed = 6;
  private pixelStartBtn: HTMLButtonElement | null = null;
  private pixelStopBtn: HTMLButtonElement | null = null;
  private pixelStatus: HTMLElement | null = null;

  // DOM
  private runCard: HTMLElement | null = null;
  private startBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private pageStatus: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private beatDot: HTMLElement | null = null;
  private meterRaf = 0;
  private logLines: string[] = [];

  private readonly unsub: () => void;

  constructor(root: HTMLElement) {
    this.el = el('div', 'music-page');
    root.append(this.el);
    this.render();
    this.unsub = subscribe(() => this.render());
  }

  destroy(): void {
    this.unsub();
    // Navigation away must not leave the keyboard in music mode — stop
    // (and restore) in the background even though this page is detached.
    if (this.running || this.starting || this.pumpDone) void this.stop();
    if (this.pixelRunning || this.pixelStarting || this.pixelPumpDone)
      void this.stopPixel();
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.el.remove();
  }

  // ── Rendering ───────────────────────────────────────────────────────

  private render(): void {
    // Device gone mid-stream: nothing to restore to — tear down now.
    if (
      !app.connected &&
      (this.running ||
        this.starting ||
        this.pumpDone ||
        this.pixelRunning ||
        this.pixelStarting ||
        this.pixelPumpDone)
    ) {
      void this.stop({
        restore: false,
        reason: 'The keyboard disconnected — music mode stopped.',
      });
      void this.stopPixel({ restore: false });
    }
    this.el.replaceChildren();
    if (!app.connected || !app.snapshot) {
      this.runCard = null;
      const c = el('section', 'card');
      c.append(el('h2', '', 'Music lighting'));
      const body = el('div', 'card-body');
      body.append(
        el(
          'p',
          'hint',
          'Make the keyboard lights dance to your music. The page listens ' +
            'through your computer\'s microphone and sends live colour frames ' +
            'to the keyboard — no extra software needed.',
        ),
      );
      body.append(el('p', 'hint warn', 'Connect a keyboard first (top-right → Connect).'));
      c.append(body);
      this.el.append(c);
      return;
    }

    this.runCard = this.renderControls();
    this.el.append(this.runCard);
    this.el.append(this.renderPixelCard());
    this.renderMeter();
    if (this.logLines.length) {
      const pre = el('pre', 'sec-log');
      pre.textContent = this.logLines.join('\n');
      this.el.append(pre);
    }
    this.syncButtons();
  }

  private renderControls(): HTMLElement {
    const c = el('section', 'card');
    c.append(el('h2', '', 'Music lighting'));
    const body = el('div', 'card-body');

    const row = el('div', 'sec-actions');
    this.startBtn = el('button', 'sec-btn', 'Start music mode');
    this.startBtn.type = 'button';
    this.stopBtn = el('button', 'sec-btn sec-btn-danger', 'Stop');
    this.stopBtn.type = 'button';
    this.startBtn.addEventListener('click', () => void this.start());
    this.stopBtn.addEventListener('click', () => void this.stop());
    row.append(this.startBtn, this.stopBtn);
    body.append(row);

    // Sliders reuse the lighting page's markup/classes.
    const sliders = el('div', 'light-sliders');
    sliders.append(
      this.makeSlider('Sensitivity', 1, 100, Math.round(this.params.sensitivity * 10), (v) => {
        this.params.sensitivity = v / 10;
      }),
    );
    sliders.append(
      this.makeSlider('Brightness', 0, 100, Math.round(this.params.brightness * 100), (v) => {
        this.params.brightness = v / 100;
      }),
    );
    body.append(sliders);

    this.pageStatus = el('p', 'hint');
    body.append(this.pageStatus);

    body.append(
      el(
        'p',
        'hint',
        'Browsers can only hear the microphone — play music out loud near the ' +
          'mic (or use speakers). When you press Stop, the keyboard goes back ' +
          'to whatever lighting it had before.',
      ),
    );
    c.append(body);
    return c;
  }

  private makeSlider(
    label: string,
    min: number,
    max: number,
    initial: number,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap = el('div', 'light-slider');
    wrap.append(el('label', 'cp-label', label));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = '1';
    range.value = String(initial);
    const valEl = el('span', 'light-val mono', String(initial));
    range.addEventListener('input', () => {
      const v = Number(range.value);
      valEl.textContent = label === 'Sensitivity' ? (v / 10).toFixed(1) : String(v);
      onInput(v);
    });
    wrap.append(range, valEl);
    return wrap;
  }

  // ── Pixel art card ──────────────────────────────────────────────────

  private renderPixelCard(): HTMLElement {
    const c = el('section', 'card');
    c.append(el('h2', '', 'Pixel art'));
    const body = el('div', 'card-body');
    body.append(
      el(
        'p',
        'hint',
        'Spell text or scroll art across the keys — no microphone needed. ' +
          'Same live-frame stream as music mode; Stop restores your lighting.',
      ),
    );

    const textRow = el('div', 'light-slider');
    textRow.append(el('label', 'cp-label', 'Text'));
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = this.pixelText;
    textInput.maxLength = 64;
    textInput.className = 'cp-input';
    textInput.addEventListener('input', () => {
      this.pixelText = textInput.value;
      this.pixelViz?.setText(textInput.value);
    });
    textRow.append(textInput);
    body.append(textRow);

    const grid = el('div', 'light-sliders');
    grid.append(this.makeSelect('Motion', this.pixelMotion, {
      static: 'Static',
      scroll_left: 'Scroll left',
      scroll_right: 'Scroll right',
    } as const, (v) => {
      this.pixelMotion = v;
      if (this.pixelViz) this.pixelViz.motion = v;
    }));
    grid.append(this.makeSelect('Palette', this.pixelPalette ?? 'none', {
      none: 'Solid colour',
      rainbow: 'Rainbow',
      heat: 'Heat',
      ocean: 'Ocean',
      sunset: 'Sunset',
      neon: 'Neon',
      mono: 'Mono',
    } as const, (v) => {
      this.pixelPalette = v === 'none' ? null : v;
      if (this.pixelViz) this.pixelViz.palette = this.pixelPalette;
    }));
    grid.append(
      this.makeSlider('Speed', 1, 30, this.pixelSpeed, (v) => {
        this.pixelSpeed = v;
        if (this.pixelViz) this.pixelViz.speed = v;
      }),
    );
    body.append(grid);

    const colourRow = el('div', 'light-slider');
    colourRow.append(el('label', 'cp-label', 'Colour'));
    const colourInput = document.createElement('input');
    colourInput.type = 'color';
    colourInput.value = rgbToHex(this.pixelColor);
    colourInput.addEventListener('input', () => {
      this.pixelColor = hexToRgb(colourInput.value);
      if (this.pixelViz) this.pixelViz.color = this.pixelColor;
    });
    colourRow.append(colourInput);
    body.append(colourRow);

    const row = el('div', 'sec-actions');
    this.pixelStartBtn = el('button', 'sec-btn', 'Start pixel art');
    this.pixelStartBtn.type = 'button';
    this.pixelStopBtn = el('button', 'sec-btn sec-btn-danger', 'Stop');
    this.pixelStopBtn.type = 'button';
    this.pixelStartBtn.addEventListener('click', () => void this.startPixel());
    this.pixelStopBtn.addEventListener('click', () => void this.stopPixel());
    row.append(this.pixelStartBtn, this.pixelStopBtn);
    body.append(row);

    this.pixelStatus = el('p', 'hint');
    body.append(this.pixelStatus);
    c.append(body);
    this.syncPixelButtons();
    return c;
  }

  private makeSelect<K extends string>(
    label: string,
    current: K,
    options: Record<K, string>,
    onChange: (v: K) => void,
  ): HTMLElement {
    const wrap = el('div', 'light-slider');
    wrap.append(el('label', 'cp-label', label));
    const sel = document.createElement('select');
    sel.className = 'cp-input';
    for (const value of Object.keys(options) as K[]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = options[value];
      o.selected = value === current;
      sel.append(o);
    }
    sel.addEventListener('change', () => onChange(sel.value as K));
    wrap.append(sel);
    return wrap;
  }

  private syncPixelButtons(): void {
    if (!this.pixelStartBtn || !this.pixelStopBtn) return;
    this.pixelStartBtn.hidden = this.pixelRunning;
    this.pixelStopBtn.hidden = !this.pixelRunning && !this.pixelStarting;
    this.pixelStartBtn.disabled = app.busy || this.pixelStarting || this.running;
  }

  private setPixelStatus(msg: string, isError = false): void {
    if (this.pixelStatus) {
      this.pixelStatus.textContent = msg;
      this.pixelStatus.classList.toggle('warn', isError);
    }
  }

  // ── Pixel-art start / stop ──────────────────────────────────────────

  private async startPixel(): Promise<void> {
    if (this.pixelRunning || this.pixelStarting || this.running || app.busy)
      return;
    const c = app.connected;
    if (!c) {
      setStatus('Connect a keyboard first.', true);
      return;
    }
    this.pixelStarting = true;
    this.pixelStopRequested = false;
    this.setPixelStatus('Saving your current lighting…');
    this.syncPixelButtons();
    try {
      const [profile, lightData] = await Promise.all([
        c.session.profile(),
        c.session.lightColorData(),
      ]);
      this.pixelSaved = { profile: profile.raw, lightData };
    } catch (e) {
      this.setPixelStatus(
        `Could not read the keyboard's lighting settings: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
      this.pixelStarting = false;
      this.syncPixelButtons();
      return;
    }
    if (this.pixelStopRequested) {
      this.pixelSaved = null;
      this.pixelStarting = false;
      this.syncPixelButtons();
      return;
    }

    const viz = new PixelArt({
      art: { kind: 'text', text: this.pixelText },
      cols: 21,
      rows: 6,
      motion: this.pixelMotion,
      speed: this.pixelSpeed,
      color: this.pixelColor,
      palette: this.pixelPalette,
    });
    viz.setGeometry(k1proGeometry());
    this.pixelViz = viz;
    this.pixelRunning = true;
    this.pixelWantRestore = true;
    this.pixelFinishPromise = null;
    this.pixelStartedAt = performance.now();
    this.pixelFramesSent = 0;
    app.musicActive = true;
    emit();
    setStatus('Pixel art is on — the keyboard shows your text.');
    this.setPixelStatus('Running… press Stop to restore your lighting.');
    this.pixelStarting = false;
    this.log(`Pixel art started ("${this.pixelText}").`);
    this.syncPixelButtons();
    this.pixelPumpDone = this.pixelPump();
  }

  private async pixelPump(): Promise<void> {
    const c = app.connected;
    const viz = this.pixelViz;
    if (!c || !viz) {
      this.pixelRunning = false;
      return;
    }
    let streamError: string | null = null;
    let last = performance.now();
    while (this.pixelRunning) {
      const tickStart = performance.now();
      try {
        const rgb = viz.frame((tickStart - last) / 1000);
        last = tickStart;
        await c.session.writeGifFrame(packPixelFrame(rgb));
        this.pixelFramesSent++;
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
        break;
      }
      const elapsed = performance.now() - tickStart;
      const wait = GIF_FRAME_PERIOD_MS - elapsed;
      await sleep(wait > 0 ? wait : 0);
    }
    this.pixelRunning = false;
    if (streamError) {
      this.log(`Pixel-art stream stopped: ${streamError}`);
      setStatus(`Pixel art stopped — ${streamError}`, true);
    }
    await this.ensurePixelFinish();
  }

  async stopPixel(opts: { restore?: boolean } = {}): Promise<void> {
    if (opts.restore === false) this.pixelWantRestore = false;
    this.pixelStopRequested = true;
    this.pixelRunning = false;
    await this.pixelPumpDone?.catch(() => {});
    this.pixelPumpDone = null;
    await this.ensurePixelFinish();
  }

  private ensurePixelFinish(): Promise<void> {
    if (!this.pixelFinishPromise) {
      this.pixelFinishPromise = this.doPixelFinish(this.pixelWantRestore);
    }
    return this.pixelFinishPromise;
  }

  private async doPixelFinish(restore: boolean): Promise<void> {
    this.pixelViz = null;
    app.musicActive = this.running; // music mode may still be streaming
    emit();
    this.syncPixelButtons();
    const c = app.connected;
    const saved = this.pixelSaved;
    this.pixelSaved = null;
    if (!restore || !c || !saved) {
      if (!this.running) setStatus('Pixel art off.');
      return;
    }
    const results: string[] = [];
    try {
      const out = await c.session.writeProfile(saved.profile);
      results.push(`lighting settings restored${out.verified ? ' (checked)' : ''}`);
    } catch (e) {
      results.push(
        `could not restore lighting settings: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const out = await c.session.writeLightData(saved.lightData);
      results.push(`effect colours restored${out.verified ? ' (checked)' : ''}`);
    } catch (e) {
      results.push(
        `could not restore effect colours: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const failed = results.some((r) => r.startsWith('could not'));
    if (!this.running) {
      setStatus(
        failed
          ? `Pixel art off — ${results.join('; ')}.`
          : 'Pixel art off — your lighting is back.',
        failed,
      );
    }
    for (const r of results) this.log(r);
    if (this.el.isConnected) this.render();
  }

  private renderMeter(): void {
    const c = el('section', 'card');
    c.append(el('h2', '', 'Live level'));
    const body = el('div', 'card-body');
    const row = el('div', 'music-meter-row');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'music-meter';
    this.canvas.width = 640;
    this.canvas.height = 72;
    this.beatDot = el('span', 'music-beat', '');
    this.beatDot.title = 'Beat detected';
    const stats = el('span', 'music-stats mono', '');
    stats.dataset.role = 'stats';
    row.append(this.canvas, this.beatDot, stats);
    body.append(row);
    body.append(
      el(
        'p',
        'hint',
        'Bass · mids · treble — the bars show what the keyboard is hearing right now.',
      ),
    );
    c.append(body);
    this.el.append(c);
    this.drawMeter();
    this.loopMeter();
  }

  // ── Meter drawing ───────────────────────────────────────────────────

  private loopMeter(): void {
    if (this.meterRaf) return;
    const tick = (): void => {
      this.drawMeter();
      this.meterRaf =
        this.running || this.bands.level > 0.01 ? requestAnimationFrame(tick) : 0;
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private drawMeter(): void {
    const cv = this.canvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const bands: [string, number][] = [
      ['Bass', this.bands.bass],
      ['Mids', this.bands.mid],
      ['Treble', this.bands.treble],
    ];
    const barW = w / bands.length;
    bands.forEach(([label, v], i) => {
      const x = i * barW + barW * 0.15;
      const bw = barW * 0.7;
      const bh = Math.max(2, Math.min(1, v) * (h - 8));
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(x, 4, bw, h - 8);
      // Accent #c6f54e (--accent) — canvas can't read CSS vars.
      const grad = ctx.createLinearGradient(0, h - bh, 0, h);
      grad.addColorStop(0, '#d4ff6a');
      grad.addColorStop(1, 'rgba(212,255,106,0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, h - 4 - bh, bw, bh);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(label, x, h - 1);
    });
    // Overall level as a thin line near the top.
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, 2, w * Math.min(1, this.bands.level), 2);
    const stats = this.el.querySelector<HTMLElement>('[data-role="stats"]');
    if (stats) {
      stats.textContent = this.running
        ? `${((performance.now() - this.startedAt) / 1000).toFixed(1)}s · ${this.framesSent} frames`
        : '';
    }
    this.beatDot?.classList.toggle('on', this.bands.beat);
  }

  private syncButtons(): void {
    if (!this.startBtn || !this.stopBtn) return;
    this.startBtn.hidden = this.running;
    this.stopBtn.hidden = !this.running && !this.starting;
    this.startBtn.disabled = app.busy || this.starting || this.pixelRunning;
  }

  private setPageStatus(msg: string, isError = false): void {
    if (this.pageStatus) {
      this.pageStatus.textContent = msg;
      this.pageStatus.classList.toggle('warn', isError);
    }
  }

  private log(msg: string): void {
    this.logLines.push(msg);
    if (this.logLines.length > 12) this.logLines.shift();
  }

  // ── Start / stop ────────────────────────────────────────────────────

  private async start(): Promise<void> {
    if (this.running || this.starting || app.busy) return;
    const c = app.connected;
    if (!c) {
      setStatus('Connect a keyboard first.', true);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.setPageStatus(
        'This browser cannot use the microphone here — open the page over ' +
          'http://localhost or an https:// address and try again.',
        true,
      );
      return;
    }
    this.starting = true;
    this.stopRequested = false;
    this.setPageStatus('Asking for microphone permission…');
    this.syncButtons();
    try {
      // Mic first (like the CLI opens audio before touching the device):
      // a permission denial should surface before any keyboard write.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0; // we smooth ourselves (dsp.rs)
      source.connect(analyser);
      this.rig = { ctx, stream, source, analyser };
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      this.analyzer = new MusicAnalyzer(ctx.sampleRate, analyser.fftSize);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      const msg =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was blocked. Allow the microphone for this ' +
            'site (click the camera/mic icon next to the address bar) and try again.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No microphone was found — plug one in or check your sound settings.'
            : `Could not open the microphone: ${e instanceof Error ? e.message : String(e)}`;
      this.setPageStatus(msg, true);
      this.teardownAudio();
      this.starting = false;
      this.syncButtons();
      return;
    }

    try {
      // Snapshot lighting for restore BEFORE streaming (CLI parity:
      // profile + cmd-138 light data, fresh reads not the page snapshot).
      this.setPageStatus('Saving your current lighting…');
      const [profile, lightData] = await Promise.all([
        c.session.profile(),
        c.session.lightColorData(),
      ]);
      this.saved = { profile: profile.raw, lightData };
    } catch (e) {
      this.teardownAudio();
      this.setPageStatus(
        `Could not read the keyboard's lighting settings: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
      this.starting = false;
      this.syncButtons();
      return;
    }

    // Stop was pressed while the mic/snapshot awaits were in flight.
    if (this.stopRequested) {
      this.teardownAudio();
      this.saved = null;
      this.starting = false;
      this.syncButtons();
      return;
    }

    this.running = true;
    this.wantRestore = true;
    this.finishPromise = null;
    this.startedAt = performance.now();
    this.framesSent = 0;
    this.bands = silentBands();
    this.viz = new SpectrumViz(this.params);
    app.musicActive = true;
    emit();
    setStatus('Music mode is on — the keyboard lights follow your microphone.');
    this.setPageStatus('Listening… press Stop to restore your lighting.');
    this.syncButtons();
    this.log('Music mode started.');
    this.starting = false;

    // Frame loop: analyse → render → fire-and-forget write, paced at
    // ~30 ms like the vendor command queue (GIF_FRAME_PERIOD_MS).
    this.pumpDone = this.pump();
  }

  private async pump(): Promise<void> {
    const c = app.connected;
    const rig = this.rig;
    const freqData = this.freqData;
    const analyzer = this.analyzer;
    if (!c || !rig || !freqData || !analyzer) {
      this.running = false;
      return;
    }
    const t0 = performance.now();
    let streamError: string | null = null;
    while (this.running) {
      const tickStart = performance.now();
      try {
        rig.analyser.getByteFrequencyData(freqData);
        this.bands = analyzer.analyze(freqData);
        const frame = this.viz.frame(this.bands, (tickStart - t0) / 1000);
        await c.session.writeGifFrame(frame);
        this.framesSent++;
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
        break;
      }
      // Pace to the vendor cadence; don't burst after a slow write.
      const elapsed = performance.now() - tickStart;
      const wait = GIF_FRAME_PERIOD_MS - elapsed;
      await sleep(wait > 0 ? wait : 0);
    }
    this.running = false;
    if (streamError) {
      this.log(`Stream stopped: ${streamError}`);
      setStatus(`Music mode stopped — ${streamError}`, true);
    }
    await this.ensureFinish();
  }

  /**
   * Stop the stream and restore the saved lighting. `restore: false` is
   * used when the device is already gone (disconnect) — there is nothing
   * to write back to.
   */
  async stop(opts: { restore?: boolean; reason?: string } = {}): Promise<void> {
    if (opts.restore === false) this.wantRestore = false;
    if (opts.reason) this.setPageStatus(opts.reason);
    this.stopRequested = true;
    this.running = false;
    await this.pumpDone?.catch(() => {});
    this.pumpDone = null;
    await this.ensureFinish();
  }

  /** Idempotent finish: tear down audio, clear the flag, restore lighting. */
  private ensureFinish(): Promise<void> {
    if (!this.finishPromise) {
      this.finishPromise = this.doFinish(this.wantRestore);
    }
    return this.finishPromise;
  }

  private async doFinish(restore: boolean): Promise<void> {
    this.teardownAudio();
    app.musicActive = false;
    emit();
    this.syncButtons();
    const c = app.connected;
    const saved = this.saved;
    this.saved = null;
    if (!restore || !c || !saved) {
      setStatus('Music mode off.');
      return;
    }
    // Restore pre-run lighting (verified writes, CLI order: profile then
    // light data). Best-effort: report failures, never throw into the UI.
    const results: string[] = [];
    try {
      const out = await c.session.writeProfile(saved.profile);
      results.push(`lighting settings restored${out.verified ? ' (checked)' : ''}`);
    } catch (e) {
      results.push(
        `could not restore lighting settings: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const out = await c.session.writeLightData(saved.lightData);
      results.push(`effect colours restored${out.verified ? ' (checked)' : ''}`);
    } catch (e) {
      results.push(
        `could not restore effect colours: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const failed = results.some((r) => r.startsWith('could not'));
    setStatus(
      failed
        ? `Music mode off — ${results.join('; ')}.`
        : 'Music mode off — your lighting is back.',
      failed,
    );
    for (const r of results) this.log(r);
    // The page may have been re-rendered while the writes were in flight.
    if (this.el.isConnected) this.render();
  }

  private teardownAudio(): void {
    const rig = this.rig;
    this.rig = null;
    this.analyzer = null;
    this.freqData = null;
    if (!rig) return;
    try {
      rig.source.disconnect();
    } catch {
      /* already disconnected */
    }
    for (const t of rig.stream.getTracks()) t.stop();
    void rig.ctx.close().catch(() => {});
  }
}

// ── Registry (same singleton-per-mount pattern as MacroPage/AdvPage) ───

let musicPage: MusicPage | null = null;

export function renderMusicPage(root: HTMLElement): void {
  if (musicPage && musicPage.el.isConnected) return;
  musicPage?.destroy();
  musicPage = new MusicPage(root);
}

export function destroyMusicPage(): void {
  musicPage?.destroy();
  musicPage = null;
}
