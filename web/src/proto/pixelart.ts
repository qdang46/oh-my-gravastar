/**
 * LED pixel-art engine — TypeScript port of
 * `crates/music/src/pixelart.rs` (bead oh-my-gravastar-49e).
 *
 * DOM-free so `scripts/smoke.ts` can exercise it under plain Node; the
 * page glue (HID streaming) lives in `../music.ts`.
 *
 * Pipeline (same as the Rust engine):
 *   1. Art strip — text rasterised once through the builtin 5×7 font
 *      into an `art_w × art_h` cell strip; motion is applied at sample
 *      time so scrolling costs nothing per frame.
 *   2. Canvas — a `cols × rows` window samples the strip; columns map
 *      1:1, rows resample vertically with OR-coverage.
 *   3. Slots — canvas cells map to colour slots either by slot order
 *      (`MapMode.Cells`) or through real key geometry (`MapMode.Keys`,
 *      the default — art follows the physical keyboard shape).
 *
 * Frames are per-slot linear RGB (0..1), `frame()` returns
 * `Float32Array` of `3 * slots` interleaved R,G,B triples — pack to
 * bytes and feed `gifFramePacket` unchanged.
 */

// ── Font ───────────────────────────────────────────────────────────────

const GLYPH_W = 5;
const GLYPH_H = 7;
const ADVANCE = GLYPH_W + 1;
const LINE_PITCH = GLYPH_H + 1;

/** `(char, rows)` — rows are `/`-separated, `#` lit. Port of FONT. */
const FONT: ReadonlyArray<readonly [string, string]> = [
  [' ', '...../...../...../...../...../...../.....'],
  ['!', '..#../..#../..#../..#../..#../...../..#..'],
  ['"', '.#.#./.#.#./.#.#./...../...../...../.....'],
  ['#', '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.'],
  ['$', '..#../.####/#.#../.###./..#.#/####./..#..'],
  ['%', '##..#/##..#/..#../.#.../#..##/#..##/.....'],
  ['&', '.#.../#..#./#.#../.#.../#.#.#/#..#./.#.#.'],
  ['\'', '..#../..#../.#.../...../...../...../.....'],
  ['(', '...#./..#../.#.../.#.../.#.../..#../...#.'],
  [')', '.#.../..#../...#./...#./...#./..#../.#...'],
  ['*', '...../.#.#./..#../.###./..#../.#.#./.....'],
  ['+', '...../..#../..#../#####/..#../..#../.....'],
  [',', '...../...../...../...../.##../.##../.#...'],
  ['-', '...../...../...../#####/...../...../.....'],
  ['.', '...../...../...../...../...../.##../.##..'],
  ['/', '....#/...#./...#./..#../.#.../#..../#....'],
  ['0', '.###./#...#/#..##/#.#.#/##..#/#...#/.###.'],
  ['1', '..#../.##../..#../..#../..#../..#../.###.'],
  ['2', '.###./#...#/....#/..##./.#.../#..../#####'],
  ['3', '####./....#/....#/.###./....#/....#/####.'],
  ['4', '...#./..##./.#.#./#..#./#####/...#./...#.'],
  ['5', '#####/#..../####./....#/....#/#...#/.###.'],
  ['6', '.###./#..../#..../####./#...#/#...#/.###.'],
  ['7', '#####/....#/...#./..#../.#.../.#.../.#...'],
  ['8', '.###./#...#/#...#/.###./#...#/#...#/.###.'],
  ['9', '.###./#...#/#...#/.####/....#/...#./.##..'],
  [':', '...../.##../.##../...../.##../.##../.....'],
  [';', '...../.##../.##../...../.##../.##../.#...'],
  ['<', '...#./..#../.#.../#..../.#.../..#../...#.'],
  ['=', '...../...../#####/...../#####/...../.....'],
  ['>', '.#.../..#../...#./....#/.#.../..#../.#...'],
  ['?', '.###./#...#/....#/..##./..#../...../..#..'],
  ['@', '.###./#...#/#.###/#.#.#/#.###/#..../.###.'],
  ['A', '.###./#...#/#...#/#####/#...#/#...#/#...#'],
  ['B', '####./#...#/#...#/####./#...#/#...#/####.'],
  ['C', '.###./#...#/#..../#..../#..../#...#/.###.'],
  ['D', '####./#...#/#...#/#...#/#...#/#...#/####.'],
  ['E', '#####/#..../#..../####./#..../#..../#####'],
  ['F', '#####/#..../#..../####./#..../#..../#....'],
  ['G', '.###./#...#/#..../#.###/#...#/#...#/.####'],
  ['H', '#...#/#...#/#...#/#####/#...#/#...#/#...#'],
  ['I', '.###./..#../..#../..#../..#../..#../.###.'],
  ['J', '..###/...#./...#./...#./...#./#..#./.##..'],
  ['K', '#...#/#..#./#.#../##.../#.#../#..#./#...#'],
  ['L', '#..../#..../#..../#..../#..../#..../#####'],
  ['M', '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#'],
  ['N', '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#'],
  ['O', '.###./#...#/#...#/#...#/#...#/#...#/.###.'],
  ['P', '####./#...#/#...#/####./#..../#..../#....'],
  ['Q', '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#'],
  ['R', '####./#...#/#...#/####./#.#../#..#./#...#'],
  ['S', '.####/#..../#..../.###./....#/....#/####.'],
  ['T', '#####/..#../..#../..#../..#../..#../..#..'],
  ['U', '#...#/#...#/#...#/#...#/#...#/#...#/.###.'],
  ['V', '#...#/#...#/#...#/#...#/.#.#./..#../..#..'],
  ['W', '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#'],
  ['X', '#...#/#...#/.#.#./..#../.#.#./#...#/#...#'],
  ['Y', '#...#/#...#/.#.#./..#../..#../..#../..#..'],
  ['Z', '#####/....#/...#./..#../.#.../#..../#####'],
  ['[', '..##./.#.../.#.../.#.../.#.../.#.../..##.'],
  ['\\', '#..../.#.../.#.../..#../...#./...#./....#'],
  [']', '.##../...#./...#./...#./...#./...#./.##..'],
  ['^', '..#../.#.#./#...#/...../...../...../.....'],
  ['_', '...../...../...../...../...../...../#####'],
  ['`', '..#../..#../.#.../...../...../...../.....'],
  ['{', '...#./..#../.#.../#..../.#.../..#../...#.'],
  ['|', '..#../..#../..#../..#../..#../..#../..#..'],
  ['}', '.#.../..#../...#./....#/...#./..#../.#...'],
  ['~', '...../..##./.#..#/#..#./.#.#./..#../.....'],
];

/** Decode one font pattern into 7 row-bytes (bit 4 = leftmost column). */
function decodeGlyph(pat: string): Uint8Array {
  const g = new Uint8Array(GLYPH_H);
  let r = 0;
  let c = 0;
  for (const ch of pat) {
    if (ch === '/') {
      r++;
      c = 0;
      continue;
    }
    if (r < GLYPH_H && c < GLYPH_W && ch === '#') g[r] |= 1 << (GLYPH_W - 1 - c);
    c++;
  }
  return g;
}

const GLYPH_CACHE = new Map<string, Uint8Array>();

function glyph(ch: string): Uint8Array {
  const cached = GLYPH_CACHE.get(ch);
  if (cached) return cached;
  const hit = FONT.find(([c]) => c === ch);
  const g = hit ? decodeGlyph(hit[1]) : new Uint8Array(GLYPH_H);
  GLYPH_CACHE.set(ch, g);
  return g;
}

// ── Palette (port of mixer.rs Palette) ─────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const RGB_BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const RGB_WHITE: Rgb = { r: 1, g: 1, b: 1 };

/** HSV → RGB (h wraps 0..1, s/v 0..1). Port of mixer.rs `hsv`. */
function hsv(h: number, s: number, v: number): Rgb {
  const hh = ((h % 1) + 1) % 1;
  const i = Math.floor(hh * 6) % 6;
  const f = hh * 6 - Math.floor(hh * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

function gradient(x: number, stops: readonly Rgb[]): Rgb {
  const n = stops.length;
  const p = x * n;
  const i = Math.floor(p) % n;
  const f = p - Math.floor(p);
  const a = stops[i]!;
  const b = stops[(i + 1) % n]!;
  return { r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f };
}

export type PaletteName = 'rainbow' | 'heat' | 'ocean' | 'sunset' | 'neon' | 'mono';

const PALETTE_STOPS: Record<Exclude<PaletteName, 'rainbow' | 'mono'>, readonly Rgb[]> = {
  heat: [
    { r: 0, g: 1, b: 0 },
    { r: 1, g: 1, b: 0 },
    { r: 1, g: 0.3, b: 0 },
    { r: 1, g: 0, b: 0 },
  ],
  ocean: [
    { r: 0, g: 0.2, b: 1 },
    { r: 0, g: 0.8, b: 1 },
    { r: 0, g: 1, b: 0.6 },
    { r: 0.3, g: 0.3, b: 1 },
  ],
  sunset: [
    { r: 1, g: 0.1, b: 0.3 },
    { r: 1, g: 0.5, b: 0 },
    { r: 1, g: 0.85, b: 0.2 },
    { r: 0.6, g: 0, b: 1 },
  ],
  neon: [
    { r: 1, g: 0, b: 1 },
    { r: 0, g: 1, b: 1 },
    { r: 0.5, g: 1, b: 0 },
    { r: 1, g: 0, b: 0.5 },
  ],
};

/** Colour at position `t` (0..1, wraps). Port of `Palette::color`. */
export function paletteColor(t: number, palette: PaletteName, mono: Rgb): Rgb {
  const x = ((t % 1) + 1) % 1;
  switch (palette) {
    case 'rainbow':
      return hsv(x, 1, 1);
    case 'mono':
      return mono;
    default:
      return gradient(x, PALETTE_STOPS[palette]);
  }
}

// ── Options / engine ───────────────────────────────────────────────────

export type Motion = 'static' | 'scroll_left' | 'scroll_right';
export type MapMode = 'cells' | 'keys';

/** What the engine displays. */
export type ArtSource =
  | { kind: 'text'; text: string }
  | { kind: 'bitmap'; width: number; height: number; pixels: Uint8Array };

export interface PixelArtOptions {
  art: ArtSource;
  cols?: number;
  rows?: number;
  motion?: Motion;
  /** `true` = marquee loops forever; `false` = parks dark off-screen. */
  repeat?: boolean;
  /** Scroll speed in strip cells per second (default 6). */
  speed?: number;
  /** Lit / mono colour (default white). */
  color?: Rgb;
  palette?: PaletteName | null;
  /** Unlit-cell colour (default black). */
  background?: Rgb;
  /** Master brightness 0..1 (default 1). */
  brightness?: number;
  map?: MapMode;
}

export interface KeyPoint {
  x: number;
  y: number;
}

/** Rasterise text into a `w × h` cell strip (0=dark, 255=lit). */
function rasterizeText(text: string): { w: number; h: number; strip: Uint8Array } {
  const lines = text.split('\n');
  const nlines = Math.max(1, lines.length);
  let artW = 0;
  for (const l of lines) {
    // Array.from counts code points like Rust `chars().count()`.
    artW = Math.max(artW, Array.from(l).length * ADVANCE - 1);
  }
  if (artW <= 0) return { w: 0, h: 0, strip: new Uint8Array(0) };
  const artH = nlines * LINE_PITCH - 1;
  const strip = new Uint8Array(artW * artH);
  for (let li = 0; li < lines.length; li++) {
    let x = 0;
    for (const ch of Array.from(lines[li]!)) {
      const g = glyph(ch);
      for (let r = 0; r < GLYPH_H; r++) {
        const row = g[r]!;
        if (row === 0) continue;
        const sy = li * LINE_PITCH + r;
        if (sy >= artH) continue;
        for (let c = 0; c < GLYPH_W; c++) {
          if (row & (1 << (GLYPH_W - 1 - c))) {
            const sx = x + c;
            if (sx < artW) strip[sy * artW + sx] = 255;
          }
        }
      }
      x += ADVANCE;
    }
  }
  return { w: artW, h: artH, strip };
}

/** For each canvas row, the strip rows it covers (OR-merge rule). */
function buildRowMap(rows: number, stripH: number): number[][] {
  const out: number[][] = [];
  if (stripH === 0) {
    for (let i = 0; i < rows; i++) out.push([]);
    return out;
  }
  for (let cy = 0; cy < rows; cy++) {
    const y0 = (cy * stripH) / rows;
    const y1 = ((cy + 1) * stripH) / rows;
    const s0 = Math.min(Math.floor(y0), stripH - 1);
    const s1 = Math.min(Math.ceil(y1), stripH);
    const hit: number[] = [];
    let best = -1;
    let bestSy = s0;
    for (let sy = s0; sy < Math.max(s1, s0 + 1); sy++) {
      if (sy >= stripH) break;
      const ov = Math.min(y1, sy + 1) - Math.max(y0, sy);
      if (ov > best) {
        best = ov;
        bestSy = sy;
      }
      if (ov >= 0.5) hit.push(sy);
    }
    if (hit.length === 0) hit.push(bestSy);
    out.push(hit);
  }
  return out;
}

function packCell(cx: number, cy: number): number {
  return (cx & 0xffff) | ((cy & 0xffff) << 16);
}

function cellOf(v: number, n: number): number {
  return Math.min(Math.floor(v * n), n - 1);
}

function scale(c: Rgb, k: number): Rgb {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

/** Normalise slot positions to 0..1 over observed bounds. */
function normaliseSlots(geom: readonly KeyPoint[]): Array<[number, number]> {
  if (geom.length === 0) return [];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const k of geom) {
    x0 = Math.min(x0, k.x);
    x1 = Math.max(x1, k.x);
    y0 = Math.min(y0, k.y);
    y1 = Math.max(y1, k.y);
  }
  const nx = (k: KeyPoint) =>
    x1 - x0 > 1e-6 ? Math.min(1, Math.max(0, (k.x - x0) / (x1 - x0))) : 0.5;
  const ny = (k: KeyPoint) =>
    y1 - y0 > 1e-6 ? Math.min(1, Math.max(0, (k.y - y0) / (y1 - y0))) : 0.5;
  return geom.map((k) => [nx(k), ny(k)] as [number, number]);
}

/** Uniform grid geometry fallback (`grid_geometry` in mixer.rs): 21
 * columns, row units for y. Positions are normalised later anyway. */
export function gridGeometry(n: number): KeyPoint[] {
  const COLS = 21;
  return Array.from({ length: n }, (_, i) => ({
    x: (i % COLS) * (16.5 / COLS) + 16.5 / (COLS * 2),
    y: Math.floor(i / COLS),
  }));
}

/**
 * Pixel-art → per-slot RGB renderer. Mirrors `PixelArt` in pixelart.rs:
 * install geometry once, pull [`PixelArt.frame`] at any rate.
 */
export class PixelArt {
  motion: Motion;
  repeat: boolean;
  speed: number;
  color: Rgb;
  palette: PaletteName | null;
  background: Rgb;
  brightness: number;

  private cols: number;
  private rows: number;
  private map: MapMode;

  private strip: Uint8Array = new Uint8Array(0);
  private artW = 0;
  private artH = 0;
  private rowMap: number[][] = [];

  private nslots = 0;
  private slotCells: number[] = [];
  private slotNorm: Array<[number, number]> = [];

  private t = 0;
  private pos = 0;
  private hue = 0;

  constructor(opts: PixelArtOptions) {
    this.motion = opts.motion ?? 'static';
    this.repeat = opts.repeat ?? true;
    this.speed = opts.speed ?? 6;
    this.color = opts.color ?? RGB_WHITE;
    this.palette = opts.palette ?? null;
    this.background = opts.background ?? RGB_BLACK;
    this.brightness = opts.brightness ?? 1;
    this.cols = Math.max(1, opts.cols ?? 21);
    this.rows = Math.max(1, opts.rows ?? 6);
    this.map = opts.map ?? 'keys';
    this.setArt(opts.art);
  }

  private setArt(art: ArtSource): void {
    if (art.kind === 'text') {
      const { w, h, strip } = rasterizeText(art.text);
      this.artW = w;
      this.artH = h;
      this.strip = strip;
    } else {
      const n = art.width * art.height;
      this.artW = art.width;
      this.artH = art.height;
      this.strip = new Uint8Array(n);
      this.strip.set(art.pixels.subarray(0, n));
    }
    this.rebuildRowMap();
  }

  setText(text: string): void {
    this.setArt({ kind: 'text', text });
  }

  setBitmap(width: number, height: number, pixels: Uint8Array): void {
    this.setArt({ kind: 'bitmap', width, height, pixels });
  }

  setCanvas(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.rebuildRowMap();
    this.rebuildSlotCells();
  }

  setMap(map: MapMode): void {
    this.map = map;
    this.rebuildSlotCells();
  }

  /** Install per-slot positions (key units); Keys mode buckets by them. */
  setGeometry(geom: readonly KeyPoint[]): void {
    this.nslots = geom.length;
    this.slotNorm = normaliseSlots(geom);
    this.rebuildSlotCells();
  }

  /** Install `n` slots with uniform grid geometry (no real keymap). */
  setSlots(n: number): void {
    this.setGeometry(gridGeometry(n));
  }

  slots(): number {
    return this.nslots;
  }

  canvas(): [number, number] {
    return [this.cols, this.rows];
  }

  artSize(): [number, number] {
    return [this.artW, this.artH];
  }

  view(): number {
    return this.computeView();
  }

  private rebuildRowMap(): void {
    this.rowMap = buildRowMap(this.rows, this.artH);
  }

  private rebuildSlotCells(): void {
    if (this.map !== 'keys' || this.slotNorm.length === 0) {
      this.slotCells = [];
      return;
    }
    this.slotCells = this.slotNorm.map(([nx, ny]) =>
      packCell(cellOf(nx, this.cols), cellOf(ny, this.rows)),
    );
  }

  private computeView(): number {
    if (this.motion === 'static' || this.artW === 0) {
      return this.artW <= this.cols ? (this.artW - this.cols) / 2 : 0;
    }
    const cols = this.cols;
    const period = this.artW + 2 * cols;
    const pos = this.repeat
      ? ((this.pos % period) + period) % period
      : Math.min(this.pos, this.artW + cols);
    if (this.motion === 'scroll_left') return pos - cols;
    return this.artW - pos; // scroll_right
  }

  /**
   * Render one frame → `Float32Array` of `3 * slots()` interleaved
   * R,G,B triples (0..1). `dt` = seconds since the previous frame.
   */
  frame(dt: number): Float32Array {
    this.t += dt;
    this.pos += dt * this.speed;
    if (this.palette !== null)
      this.hue = (((this.hue + 0.1 * this.speed * dt) % 1) + 1) % 1;

    const n = this.nslots;
    const out = new Float32Array(n * 3);
    const bg = scale(this.background, this.brightness);
    for (let i = 0; i < n; i++) {
      out[i * 3] = bg.r;
      out[i * 3 + 1] = bg.g;
      out[i * 3 + 2] = bg.b;
    }
    if (this.artW === 0 || this.artH === 0 || n === 0) return out;

    const view = this.computeView();
    const { artW, strip, rowMap } = this;
    for (let i = 0; i < n; i++) {
      let cell: number;
      if (this.map === 'cells') {
        if (i >= this.cols * this.rows) continue;
        cell = packCell(i % this.cols, Math.floor(i / this.cols));
      } else {
        const c = this.slotCells[i];
        if (c === undefined) continue;
        cell = c;
      }
      const cx = cell & 0xffff;
      const cy = cell >>> 16;
      if (cy >= rowMap.length) continue;
      const sx = Math.floor(view + cx);
      if (sx < 0 || sx >= artW) continue;
      let v = 0;
      for (const sy of rowMap[cy]!) {
        const s = sy * artW + sx;
        if (strip[s]! > v) v = strip[s]!;
        if (v === 255) break;
      }
      if (v === 0) continue;
      const base =
        this.palette !== null
          ? paletteColor(sx / artW + this.hue, this.palette, this.color)
          : this.color;
      const k = (v / 255) * this.brightness;
      out[i * 3] = base.r * k;
      out[i * 3 + 1] = base.g * k;
      out[i * 3 + 2] = base.b * k;
    }
    return out;
  }
}
