//! LED pixel-art engine — turn a string (or a raw bitmap) into per-key
//! RGB frames over the real device geometry (bead 49e).
//!
//! Unlike the music renderers this is **not** audio-reactive: the agent
//! lights physical key LEDs to spell letters, show pixel art, or run a
//! marquee. The pipeline is:
//!
//! 1. **Art strip** — text is rasterised once through a builtin 5×7
//!    bitmap font ([`FONT`]) into a `art_w × art_h` cell strip; a
//!    [`ArtSource::Bitmap`] is used as-is. The strip is static; motion
//!    is applied at sample time so scrolling costs nothing per frame.
//! 2. **Canvas** — a `cols × rows` window samples the strip. Columns
//!    map 1:1 (the canvas is a sliding window `view..view+cols` into
//!    the strip); rows resample vertically with OR-coverage so e.g. a
//!    7-row font still reads on a 6-row keyboard (adjacent font rows
//!    merge instead of dropping a whole row).
//! 3. **Slots** — canvas cells are mapped to colour slots either by
//!    slot order ([`MapMode::Cells`], for raster-ordered matrices) or
//!    through real [`KeyPoint`] geometry ([`MapMode::Keys`], the
//!    default — art follows the physical keyboard shape).
//!
//! Frames are `Vec<Rgb>` over `slots()` exactly like
//! [`crate::mixer::ModeRenderer`], so the existing `pack_frame` +
//! cmd-8 streaming path consumes them unchanged.
//!
//! # Recommended canvas sizes
//!
//! - **K1 Pro / K98 (126 slots, ~6 physical rows, x 0…16.5):**
//!   `cols = 21, rows = 6` → 126 canvas cells, one per slot in
//!   [`MapMode::Cells`]; in [`MapMode::Keys`] each physical row lands
//!   on one canvas row. The 7-px font vertically merges onto 6 rows —
//!   legible, slightly bold bottoms. `cols = 22` also works (right
//!   edge has a few dark cells).
//! - **Generic / unknown geometry:** `cols = 22, rows = 7` gives the
//!   font native resolution; fall back to [`PixelArt::set_slots`]
//!   uniform geometry when no keymap is available.
//!
//! # Font format
//!
//! [`FONT`] stores each glyph as a `&str` of 7 rows × 5 columns,
//! `#` = lit, `.`/anything-else = unlit, rows separated by `/`
//! (e.g. `'A'` = `".###./#...#/#...#/#####/#...#/#...#/#...#"`).
//! Bit order after decode: row byte bit 4 = leftmost column. Unknown
//! characters render as blank (space) but still advance.

use crate::mixer::{grid_geometry, KeyPoint, Palette, Rgb};

// ── Font ───────────────────────────────────────────────────────────────

/// Glyph pixel width in cells.
const GLYPH_W: usize = 5;
/// Glyph pixel height in cells.
const GLYPH_H: usize = 7;
/// Horizontal advance per character (glyph + 1-cell spacing).
const ADVANCE: usize = GLYPH_W + 1;
/// Vertical pitch per text line (glyph + 1-cell spacing).
const LINE_PITCH: usize = GLYPH_H + 1;

/// Builtin 5×7 font: `(char, rows)`. Rows are `/`-separated, `#` lit.
/// Covers A–Z, 0–9, space and common punctuation. See module docs for
/// the format; add a row here (and a doc note in the protocol of the
/// change) before relying on a new glyph.
const FONT: &[(char, &str)] = &[
    (' ', "...../...../...../...../...../...../....."),
    ('!', "..#../..#../..#../..#../..#../...../..#.."),
    ('"', ".#.#./.#.#./.#.#./...../...../...../....."),
    ('#', ".#.#./.#.#./#####/.#.#./#####/.#.#./.#.#."),
    ('$', "..#../.####/#.#../.###./..#.#/####./..#.."),
    ('%', "##..#/##..#/..#../.#.../#..##/#..##/....."),
    ('&', ".#.../#..#./#.#../.#.../#.#.#/#..#./.#.#."),
    ('\'', "..#../..#../.#.../...../...../...../....."),
    ('(', "...#./..#../.#.../.#.../.#.../..#../...#."),
    (')', ".#.../..#../...#./...#./...#./..#../.#..."),
    ('*', "...../.#.#./..#../.###./..#../.#.#./....."),
    ('+', "...../..#../..#../#####/..#../..#../....."),
    (',', "...../...../...../...../.##../.##../.#..."),
    ('-', "...../...../...../#####/...../...../....."),
    ('.', "...../...../...../...../...../.##../.##.."),
    ('/', "....#/...#./...#./..#../.#.../#..../#...."),
    ('0', ".###./#...#/#..##/#.#.#/##..#/#...#/.###."),
    ('1', "..#../.##../..#../..#../..#../..#../.###."),
    ('2', ".###./#...#/....#/..##./.#.../#..../#####"),
    ('3', "####./....#/....#/.###./....#/....#/####."),
    ('4', "...#./..##./.#.#./#..#./#####/...#./...#."),
    ('5', "#####/#..../####./....#/....#/#...#/.###."),
    ('6', ".###./#..../#..../####./#...#/#...#/.###."),
    ('7', "#####/....#/...#./..#../.#.../.#.../.#..."),
    ('8', ".###./#...#/#...#/.###./#...#/#...#/.###."),
    ('9', ".###./#...#/#...#/.####/....#/...#./.##.."),
    (':', "...../.##../.##../...../.##../.##../....."),
    (';', "...../.##../.##../...../.##../.##../.#..."),
    ('<', "...#./..#../.#.../#..../.#.../..#../...#."),
    ('=', "...../...../#####/...../#####/...../....."),
    ('>', ".#.../..#../...#./....#/.#.../..#../.#..."),
    ('?', ".###./#...#/....#/..##./..#../...../..#.."),
    ('@', ".###./#...#/#.###/#.#.#/#.###/#..../.###."),
    ('A', ".###./#...#/#...#/#####/#...#/#...#/#...#"),
    ('B', "####./#...#/#...#/####./#...#/#...#/####."),
    ('C', ".###./#...#/#..../#..../#..../#...#/.###."),
    ('D', "####./#...#/#...#/#...#/#...#/#...#/####."),
    ('E', "#####/#..../#..../####./#..../#..../#####"),
    ('F', "#####/#..../#..../####./#..../#..../#...."),
    ('G', ".###./#...#/#..../#.###/#...#/#...#/.####"),
    ('H', "#...#/#...#/#...#/#####/#...#/#...#/#...#"),
    ('I', ".###./..#../..#../..#../..#../..#../.###."),
    ('J', "..###/...#./...#./...#./...#./#..#./.##.."),
    ('K', "#...#/#..#./#.#../##.../#.#../#..#./#...#"),
    ('L', "#..../#..../#..../#..../#..../#..../#####"),
    ('M', "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#"),
    ('N', "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#"),
    ('O', ".###./#...#/#...#/#...#/#...#/#...#/.###."),
    ('P', "####./#...#/#...#/####./#..../#..../#...."),
    ('Q', ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#"),
    ('R', "####./#...#/#...#/####./#.#../#..#./#...#"),
    ('S', ".####/#..../#..../.###./....#/....#/####."),
    ('T', "#####/..#../..#../..#../..#../..#../..#.."),
    ('U', "#...#/#...#/#...#/#...#/#...#/#...#/.###."),
    ('V', "#...#/#...#/#...#/#...#/#...#/.#.#./..#.."),
    ('W', "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#"),
    ('X', "#...#/#...#/.#.#./..#../.#.#./#...#/#...#"),
    ('Y', "#...#/#...#/.#.#./..#../..#../..#../..#.."),
    ('Z', "#####/....#/...#./..#../.#.../#..../#####"),
    ('[', "..##./.#.../.#.../.#.../.#.../.#.../..##."),
    ('\\', "#..../.#.../.#.../..#../...#./...#./....#"),
    (']', ".##../...#./...#./...#./...#./...#./.##.."),
    ('^', "..#../.#.#./#...#/...../...../...../....."),
    ('_', "...../...../...../...../...../...../#####"),
    ('`', "..#../..#../.#.../...../...../...../....."),
    ('{', "...#./..#../.#.../#..../.#.../..#../...#."),
    ('|', "..#../..#../..#../..#../..#../..#../..#.."),
    ('}', ".#.../..#../...#./....#/...#./..#../.#..."),
    ('~', "...../..##./.#..#/#..#./.#.#./..#../....."),
];

/// Decode one font pattern into 7 row-bytes (bit 4 = leftmost column).
fn decode_glyph(pat: &str) -> [u8; GLYPH_H] {
    let mut g = [0u8; GLYPH_H];
    let mut r = 0usize;
    let mut c = 0usize;
    for &b in pat.as_bytes() {
        if b == b'/' {
            r += 1;
            c = 0;
            continue;
        }
        if r < GLYPH_H && c < GLYPH_W && b == b'#' {
            g[r] |= 1 << (GLYPH_W - 1 - c);
        }
        c += 1;
    }
    g
}

/// Font lookup; unknown chars → all-zero (blank) glyph.
fn glyph(ch: char) -> [u8; GLYPH_H] {
    FONT.iter()
        .find(|(c, _)| *c == ch)
        .map(|(_, p)| decode_glyph(p))
        .unwrap_or([0u8; GLYPH_H])
}

// ── Art source ─────────────────────────────────────────────────────────

/// What the engine displays. Text is rasterised once into the strip;
/// bitmaps are taken as-is (caller can swap them between frames for
/// hand-drawn animation).
#[derive(Clone, Debug)]
pub enum ArtSource {
    /// Text with `\n` line breaks. Glyphs are 5×7 cells, advance 6,
    /// line pitch 8. Unknown characters render blank.
    Text(String),
    /// Raw pixel art: `width`×`height` cells, row-major, each byte
    /// 0…=255 intensity (multiplies [`PixelArt::color`]). Shorter
    /// `pixels` read as zero-padded; longer are truncated.
    Bitmap {
        width: usize,
        height: usize,
        pixels: Vec<u8>,
    },
}

impl ArtSource {
    /// Convenience: text art.
    pub fn text(s: impl Into<String>) -> Self {
        Self::Text(s.into())
    }
    /// Convenience: bitmap art.
    pub fn bitmap(width: usize, height: usize, pixels: Vec<u8>) -> Self {
        Self::Bitmap {
            width,
            height,
            pixels,
        }
    }
}

// ── Options ────────────────────────────────────────────────────────────

/// How the art moves across the canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    /// Hold the art centred (or left-aligned when wider than the canvas).
    Static,
    /// Marquee: art enters from the right edge and travels left.
    ScrollLeft,
    /// Marquee: art enters from the left edge and travels right.
    ScrollRight,
}

/// How canvas cells map to colour slots.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MapMode {
    /// Slot-order matrix: slot `i` lights canvas cell `i` (row-major
    /// over `cols`×`rows`). No geometry needed — use when slot order
    /// already is the display raster. Slots beyond `cols*rows` stay
    /// dark; unused trailing cells stay dark.
    Cells,
    /// Physical mapping: every slot samples the canvas cell under its
    /// [`KeyPoint`] position (x normalised across observed bounds,
    /// y likewise). Art follows the real keyboard shape. Falls back to
    /// [`grid_geometry`] when [`PixelArt::set_slots`] is used.
    Keys,
}

/// Construction-time configuration for [`PixelArt`].
pub struct PixelArtSpec {
    /// What to display.
    pub art: ArtSource,
    /// Canvas columns (strip cells visible across). Default 21.
    pub cols: usize,
    /// Canvas rows. Default 6 — matches the K1 Pro physical row count;
    /// the 7-row font vertically merges onto 6 rows. Use 7+ for native
    /// font resolution on taller/abstract displays.
    pub rows: usize,
    /// Motion. Default [`Motion::Static`].
    pub motion: Motion,
    /// Scroll wrap: `true` = marquee loops forever; `false` = scroll
    /// plays once and parks fully off-screen (dark board). Default true.
    pub repeat: bool,
    /// Scroll speed in strip cells per second. Default 6.0 — a
    /// character (6 cells) crosses in ~1 s. dt-scaled.
    pub speed: f32,
    /// Lit colour when `palette` is `None`; also the mono colour when
    /// `palette` is [`Palette::Mono`]. Default white.
    pub color: Rgb,
    /// Optional per-frame colour cycling: lit colour becomes
    /// `palette.color(t + hue, color)` where `t` is the strip column
    /// normalised 0…1, so the rainbow travels with the art. `hue`
    /// drifts `0.1·speed` cycles/s. Default `None` (solid `color`).
    pub palette: Option<Palette>,
    /// Colour of unlit canvas cells (e.g. a dim glow behind the art).
    /// Default black.
    pub background: Rgb,
    /// Master brightness 0…1 applied at the end. Default 1.0.
    pub brightness: f32,
    /// Slot mapping. Default [`MapMode::Keys`].
    pub map: MapMode,
}

impl Default for PixelArtSpec {
    fn default() -> Self {
        Self {
            art: ArtSource::Text(String::new()),
            cols: 21,
            rows: 6,
            motion: Motion::Static,
            repeat: true,
            speed: 6.0,
            color: Rgb {
                r: 1.0,
                g: 1.0,
                b: 1.0,
            },
            palette: None,
            background: Rgb::BLACK,
            brightness: 1.0,
            map: MapMode::Keys,
        }
    }
}

impl PixelArtSpec {
    /// Spec showing `text` with all other defaults.
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            art: ArtSource::Text(text.into()),
            ..Default::default()
        }
    }
}

// ── Engine ─────────────────────────────────────────────────────────────

/// Pixel-art → per-slot RGB renderer. Mirrors [`crate::mixer::ModeRenderer`]:
/// install geometry once, pull [`PixelArt::frame`] at any rate.
pub struct PixelArt {
    // Live-tunable fields (safe to mutate between frames).
    /// Motion mode.
    pub motion: Motion,
    /// Scroll wrap (see [`PixelArtSpec::repeat`]).
    pub repeat: bool,
    /// Scroll speed, strip cells/sec.
    pub speed: f32,
    /// Lit / mono colour.
    pub color: Rgb,
    /// Optional palette colour cycling.
    pub palette: Option<Palette>,
    /// Unlit-cell colour.
    pub background: Rgb,
    /// Master brightness 0…1.
    pub brightness: f32,

    cols: usize,
    rows: usize,
    map: MapMode,

    /// Static art strip, row-major `art_w × art_h`, 0=dark 255=lit
    /// (bitmaps keep their own 0…255 intensities).
    strip: Vec<u8>,
    art_w: usize,
    art_h: usize,
    /// Per canvas row: the strip rows it covers (OR-merged). Built from
    /// `rows`×`art_h`; see module docs for the resample rule.
    row_map: Vec<Vec<u16>>,

    /// Colour-slot count (from the last `set_geometry`/`set_slots`).
    nslots: usize,
    /// Keys mode: packed `cx | cy<<16` canvas cell per slot.
    slot_cells: Vec<u32>,
    /// Normalised per-slot coords `(nx, ny)` in 0…1, kept so
    /// [`PixelArt::set_canvas`] can re-bucket without the geometry.
    slot_norm: Vec<(f32, f32)>,

    t: f32,
    /// Scroll position in strip cells (always advances; direction and
    /// wrap are applied when computing `view`).
    pos: f32,
    /// Palette drift, cycles.
    hue: f32,
}

impl PixelArt {
    /// Build an engine from `spec`. Geometry is *not* known yet — call
    /// [`PixelArt::set_geometry`] or [`PixelArt::set_slots`] before
    /// pulling frames or `slots()` stays 0.
    pub fn new(spec: PixelArtSpec) -> Self {
        let mut p = Self {
            motion: spec.motion,
            repeat: spec.repeat,
            speed: spec.speed,
            color: spec.color,
            palette: spec.palette,
            background: spec.background,
            brightness: spec.brightness,
            cols: spec.cols.max(1),
            rows: spec.rows.max(1),
            map: spec.map,
            strip: Vec::new(),
            art_w: 0,
            art_h: 0,
            row_map: Vec::new(),
            nslots: 0,
            slot_cells: Vec::new(),
            slot_norm: Vec::new(),
            t: 0.0,
            pos: 0.0,
            hue: 0.0,
        };
        p.set_art(spec.art);
        p
    }

    /// Replace the art and rebuild the strip.
    pub fn set_art(&mut self, art: ArtSource) {
        let (w, h, strip) = match art {
            ArtSource::Text(text) => rasterize_text(&text),
            ArtSource::Bitmap {
                width,
                height,
                pixels,
            } => {
                let n = width.saturating_mul(height);
                let mut strip = pixels;
                strip.resize(n, 0);
                strip.truncate(n);
                (width, height, strip)
            }
        };
        self.art_w = w;
        self.art_h = h;
        self.strip = strip;
        self.rebuild_row_map();
    }

    /// Replace the text (convenience for [`ArtSource::Text`]).
    pub fn set_text(&mut self, text: &str) {
        self.set_art(ArtSource::Text(text.to_string()));
    }

    /// Replace the bitmap (convenience for [`ArtSource::Bitmap`]).
    pub fn set_bitmap(&mut self, width: usize, height: usize, pixels: Vec<u8>) {
        self.set_art(ArtSource::Bitmap {
            width,
            height,
            pixels,
        });
    }

    /// Change the canvas size; remaps rows and (for [`MapMode::Keys`])
    /// re-buckets slots. `cols`/`rows` are clamped to ≥1.
    pub fn set_canvas(&mut self, cols: usize, rows: usize) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.rebuild_row_map();
        self.rebuild_slot_cells();
    }

    /// Change the slot mapping mode. [`MapMode::Cells`] needs no
    /// geometry; switching to [`MapMode::Keys`] requires geometry to
    /// have been installed (otherwise slots stay dark until
    /// [`PixelArt::set_geometry`]/[`PixelArt::set_slots`] is called).
    pub fn set_map(&mut self, map: MapMode) {
        self.map = map;
        self.rebuild_slot_cells();
    }

    /// Install per-slot positions (`x`/`y` in key units, see
    /// [`crate::mixer`]). For [`MapMode::Keys`] each slot is bucketed
    /// into a canvas cell by normalised position; for
    /// [`MapMode::Cells`] only the slot count matters.
    pub fn set_geometry(&mut self, geom: &[KeyPoint]) {
        self.nslots = geom.len();
        self.slot_norm = normalise_slots(geom);
        self.rebuild_slot_cells();
    }

    /// Install `n` slots with no real geometry: [`MapMode::Cells`]
    /// treats them as a raster matrix; [`MapMode::Keys`] falls back to
    /// [`grid_geometry`] (uniform spread over the board).
    pub fn set_slots(&mut self, n: usize) {
        self.set_geometry(&grid_geometry(n));
    }

    /// Number of colour slots covered (0 until geometry/slots set).
    pub fn slots(&self) -> usize {
        self.nslots
    }

    /// Canvas dimensions `(cols, rows)` in strip cells.
    pub fn canvas(&self) -> (usize, usize) {
        (self.cols, self.rows)
    }

    /// Art strip dimensions `(width, height)` in cells.
    pub fn art_size(&self) -> (usize, usize) {
        (self.art_w, self.art_h)
    }

    /// Current scroll window position in strip cells (diagnostics).
    pub fn view(&self) -> f32 {
        self.compute_view()
    }

    fn rebuild_row_map(&mut self) {
        self.row_map = build_row_map(self.rows, self.art_h);
    }

    /// Recompute Keys-mode slot buckets from the stored normalised
    /// coords so canvas resizes re-bucket without re-feeding geometry.
    fn rebuild_slot_cells(&mut self) {
        if self.map != MapMode::Keys || self.slot_norm.is_empty() {
            self.slot_cells.clear();
            return;
        }
        self.slot_cells = self
            .slot_norm
            .iter()
            .map(|&(nx, ny)| pack_cell(cell_of(nx, self.cols), cell_of(ny, self.rows)))
            .collect();
    }

    /// Strip-column window origin for this frame (may be fractional or
    /// negative; canvas cell `cx` shows strip column `floor(view+cx)`).
    fn compute_view(&self) -> f32 {
        if self.motion == Motion::Static || self.art_w == 0 {
            // Centre the strip; left-align when it overflows.
            return if self.art_w <= self.cols {
                (self.art_w as f32 - self.cols as f32) / 2.0
            } else {
                0.0
            };
        }
        let cols = self.cols as f32;
        let period = (self.art_w + 2 * self.cols) as f32;
        let pos = if self.repeat {
            self.pos.rem_euclid(period)
        } else {
            // Play once, then park fully off-screen (dark board).
            self.pos.min((self.art_w + self.cols) as f32)
        };
        match self.motion {
            // pos 0 → art just off the right edge; travels left.
            Motion::ScrollLeft => pos - cols,
            // pos 0 → art just off the left edge; travels right.
            Motion::ScrollRight => self.art_w as f32 - pos,
            Motion::Static => unreachable!(),
        }
    }

    /// Render one frame → per-slot linear RGB (len = `slots()`).
    /// `dt` = seconds since the previous frame; all motion is
    /// dt-scaled so speed is frame-rate independent.
    pub fn frame(&mut self, dt: f32) -> Vec<Rgb> {
        self.t += dt;
        self.pos += dt * self.speed;
        if self.palette.is_some() {
            // ~10 s per hue cycle at speed 1.
            self.hue = (self.hue + 0.1 * self.speed * dt).rem_euclid(1.0);
        }

        let n = self.nslots;
        let mut out = vec![scale(self.background, self.brightness); n];
        if self.art_w == 0 || self.art_h == 0 || n == 0 {
            return out;
        }
        let view = self.compute_view();
        let art_w = self.art_w;
        let strip = &self.strip;
        let row_map = &self.row_map;

        for (i, o) in out.iter_mut().enumerate() {
            let cell = match self.map {
                MapMode::Cells => {
                    if i < self.cols * self.rows {
                        pack_cell(i % self.cols, i / self.cols)
                    } else {
                        continue;
                    }
                }
                MapMode::Keys => match self.slot_cells.get(i) {
                    Some(&c) => c,
                    None => continue,
                },
            };
            let cx = (cell & 0xFFFF) as usize;
            let cy = (cell >> 16) as usize;
            if cy >= row_map.len() {
                continue;
            }
            // Horizontal is 1:1 (window into the strip).
            let sx = (view + cx as f32).floor();
            if !(0.0..art_w as f32).contains(&sx) {
                continue;
            }
            let sx = sx as usize;
            // Vertical OR-coverage: a canvas cell is lit if any covered
            // strip row is lit; intensity = max coverage.
            let mut v = 0u8;
            for &sy in &row_map[cy] {
                let s = sy as usize * art_w + sx;
                v = v.max(strip[s]);
                if v == 255 {
                    break;
                }
            }
            if v == 0 {
                continue;
            }
            let base = match self.palette {
                Some(p) => {
                    let t = sx as f32 / art_w as f32 + self.hue;
                    p.color(t, self.color)
                }
                None => self.color,
            };
            *o = scale(base, v as f32 / 255.0 * self.brightness);
        }
        out
    }
}

// ── Internals ──────────────────────────────────────────────────────────

fn pack_cell(cx: usize, cy: usize) -> u32 {
    (cx as u32 & 0xFFFF) | ((cy as u32 & 0xFFFF) << 16)
}

fn cell_of(v: f32, n: usize) -> usize {
    ((v * n as f32) as usize).min(n - 1)
}

/// Normalise slot positions to 0…1 using the observed geometry bounds
/// so art fills the canvas on any device; degenerate axes → 0.5.
fn normalise_slots(geom: &[KeyPoint]) -> Vec<(f32, f32)> {
    if geom.is_empty() {
        return Vec::new();
    }
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for k in geom {
        x0 = x0.min(k.x);
        x1 = x1.max(k.x);
        y0 = y0.min(k.y);
        y1 = y1.max(k.y);
    }
    let nx = |k: &KeyPoint| {
        if x1 - x0 > 1e-6 {
            ((k.x - x0) / (x1 - x0)).clamp(0.0, 1.0)
        } else {
            0.5
        }
    };
    let ny = |k: &KeyPoint| {
        if y1 - y0 > 1e-6 {
            ((k.y - y0) / (y1 - y0)).clamp(0.0, 1.0)
        } else {
            0.5
        }
    };
    geom.iter().map(|k| (nx(k), ny(k))).collect()
}

/// Scale a colour by `k` (local helper — `Rgb::scale` is private to
/// the mixer module).
fn scale(c: Rgb, k: f32) -> Rgb {
    Rgb {
        r: c.r * k,
        g: c.g * k,
        b: c.b * k,
    }
}

/// For each canvas row, the strip rows it covers. A strip row is
/// included when its overlap with the canvas row's strip-space extent
/// is ≥ 0.5 cells, plus the best-overlapping row as a fallback so no
/// canvas row is ever empty. Down-sampling merges adjacent strip rows
/// (OR at render); up-sampling may repeat them.
fn build_row_map(rows: usize, strip_h: usize) -> Vec<Vec<u16>> {
    if strip_h == 0 {
        return vec![Vec::new(); rows];
    }
    let mut out = Vec::with_capacity(rows);
    for cy in 0..rows {
        let y0 = cy as f32 * strip_h as f32 / rows as f32;
        let y1 = (cy + 1) as f32 * strip_h as f32 / rows as f32;
        let s0 = (y0.floor() as usize).min(strip_h - 1);
        let s1 = (y1.ceil() as usize).min(strip_h);
        let mut hit = Vec::new();
        let (mut best, mut best_sy) = (-1.0f32, s0);
        for sy in s0..s1.max(s0 + 1) {
            if sy >= strip_h {
                break;
            }
            let ov = y1.min(sy as f32 + 1.0) - y0.max(sy as f32);
            if ov > best {
                best = ov;
                best_sy = sy;
            }
            if ov >= 0.5 {
                hit.push(sy as u16);
            }
        }
        if hit.is_empty() {
            hit.push(best_sy as u16);
        }
        out.push(hit);
    }
    out
}

/// Rasterise text into a `w × h` cell strip (0=dark, 255=lit).
fn rasterize_text(text: &str) -> (usize, usize, Vec<u8>) {
    let lines: Vec<&str> = text.split('\n').collect();
    let nlines = lines.len().max(1);
    let art_w = lines
        .iter()
        .map(|l| l.chars().count().saturating_mul(ADVANCE).saturating_sub(1))
        .max()
        .unwrap_or(0);
    if art_w == 0 {
        return (0, 0, Vec::new());
    }
    let art_h = nlines.saturating_mul(LINE_PITCH).saturating_sub(1);
    let mut strip = vec![0u8; art_w.saturating_mul(art_h)];
    for (li, line) in lines.iter().enumerate() {
        let mut x = 0usize;
        for ch in line.chars() {
            let g = glyph(ch);
            for (r, &row) in g.iter().enumerate() {
                if row == 0 {
                    continue;
                }
                let sy = li * LINE_PITCH + r;
                if sy >= art_h {
                    continue;
                }
                for c in 0..GLYPH_W {
                    if row & (1 << (GLYPH_W - 1 - c)) != 0 {
                        let sx = x + c;
                        if sx < art_w {
                            strip[sy * art_w + sx] = 255;
                        }
                    }
                }
            }
            x += ADVANCE;
        }
    }
    (art_w, art_h, strip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(text: &str) -> PixelArt {
        let mut p = PixelArt::new(PixelArtSpec {
            art: ArtSource::text(text),
            ..Default::default()
        });
        p.set_slots(126);
        p
    }

    #[test]
    fn font_covers_alnum_and_punct() {
        for c in 'A'..='Z' {
            assert!(glyph(c).iter().any(|&r| r != 0), "glyph {c} empty");
        }
        for c in '0'..='9' {
            assert!(glyph(c).iter().any(|&r| r != 0), "glyph {c} empty");
        }
        for c in " !?.,-_:;'\"/\\()+=<>@#$%&*[]^~`|{}".chars() {
            // Every listed punct must exist in FONT (space may be blank).
            assert!(FONT.iter().any(|(f, _)| *f == c), "missing glyph {c}");
        }
        // Unknown chars decode to blank.
        assert!(glyph('€').iter().all(|&r| r == 0));
        assert!(glyph('\t').iter().all(|&r| r == 0));
    }

    #[test]
    fn rasterize_bounds_and_advance() {
        let (w, h, strip) = rasterize_text("HI");
        assert_eq!(w, 2 * ADVANCE - 1);
        assert_eq!(h, LINE_PITCH - 1);
        assert_eq!(strip.len(), w * h);
        // 'H' left stem column 0 must be lit in every glyph row that
        // has pixels (rows 0,1,2,3,4,5,6 all lit at col 0 for 'H').
        assert!(strip[0] == 255, "H top-left must be lit");
        // Multiline: "A\nB" → height = 2*8-1 = 15.
        let (w2, h2, _) = rasterize_text("A\nB");
        assert_eq!(h2, 2 * LINE_PITCH - 1);
        assert_eq!(w2, GLYPH_W, "single-char lines → one glyph wide");
        // Empty text → empty strip, no panic downstream.
        let (w3, h3, s3) = rasterize_text("");
        assert_eq!((w3, h3), (0, 0));
        assert!(s3.is_empty());
    }

    #[test]
    fn cells_mode_maps_slot_order() {
        let mut p = PixelArt::new(PixelArtSpec {
            art: ArtSource::text("HI"),
            map: MapMode::Cells,
            ..Default::default()
        });
        p.set_canvas(21, 6);
        p.set_slots(126);
        assert_eq!(p.slots(), 126);
        let frame = p.frame(0.016);
        assert_eq!(frame.len(), 126);
        // "HI" is 11 cells wide centred on 21 cols → lit cells around
        // cols 5..16, canvas rows centred vertically (7→6 merge).
        let lit: Vec<usize> = frame
            .iter()
            .enumerate()
            .filter(|(_, c)| c.r + c.g + c.b > 0.05)
            .map(|(i, _)| i)
            .collect();
        assert!(!lit.is_empty(), "static text must light keys");
        // Every lit slot must be a valid canvas cell (< 126).
        assert!(lit.iter().all(|&i| i < 126));
    }

    #[test]
    fn keys_mode_bounds_and_coverage() {
        let mut p = engine("HELLO");
        p.set_map(MapMode::Keys);
        p.motion = Motion::Static;
        let frame = p.frame(0.016);
        assert_eq!(frame.len(), 126);
        let lit = frame.iter().filter(|c| c.r + c.g + c.b > 0.05).count();
        assert!(lit > 10, "Keys mode must light many slots, got {lit}");
        // Slot cells must stay inside the canvas: recompute directly.
        let norm = normalise_slots(&grid_geometry(126));
        for &(nx, ny) in &norm {
            assert!(cell_of(nx, p.cols) < p.cols);
            assert!(cell_of(ny, p.rows) < p.rows);
        }
    }

    #[test]
    fn scroll_wraps_and_dt_scales() {
        let mut a = engine("HI");
        a.motion = Motion::ScrollLeft;
        a.repeat = true;
        a.speed = 30.0; // fast: crosses 35-cell period in >1 s
                        // Run 5 s at 30 fps.
        let mut frames = Vec::new();
        for _ in 0..150 {
            frames.push(a.frame(1.0 / 30.0));
        }
        // Text must appear and disappear (marquee).
        let lit_counts: Vec<usize> = frames
            .iter()
            .map(|f| f.iter().filter(|c| c.r + c.g + c.b > 0.05).count())
            .collect();
        assert!(lit_counts.iter().any(|&n| n > 0), "scroll must show text");
        assert!(lit_counts.contains(&0), "scroll must blank between passes");
        // dt-scaling: same wall time, coarser dt → same view position.
        let mut b = engine("HI");
        b.motion = Motion::ScrollLeft;
        b.repeat = true;
        b.speed = 30.0;
        for _ in 0..50 {
            b.frame(0.1);
        }
        assert!(
            (a.view() - b.view()).abs() < 1e-3,
            "view {} vs {}",
            a.view(),
            b.view()
        );
        // Non-loop parks dark after one pass.
        let mut c = engine("HI");
        c.motion = Motion::ScrollLeft;
        c.repeat = false;
        c.speed = 60.0;
        let mut last_lit = usize::MAX;
        for _ in 0..600 {
            let f = c.frame(1.0 / 30.0);
            last_lit = f.iter().filter(|x| x.r + x.g + x.b > 0.05).count();
        }
        assert_eq!(last_lit, 0, "non-loop scroll must end dark");
    }

    #[test]
    fn scroll_right_mirrors() {
        let mut p = engine("HI");
        p.motion = Motion::ScrollRight;
        p.speed = 20.0;
        // At pos≈0 text is just off the left edge: view = art_w = 11.
        assert!((p.view() - 11.0).abs() < 1e-3);
        for _ in 0..30 {
            p.frame(1.0 / 30.0);
        }
        // After 1 s at 20 cells/s pos=20 → view = art_w - pos = -9.
        assert!((p.view() - (-9.0)).abs() < 1e-3, "view={}", p.view());
        let f = p.frame(0.0);
        assert_eq!(f.len(), 126);
    }

    #[test]
    fn palette_and_brightness_apply() {
        let mut p = engine("HI");
        p.palette = Some(Palette::Rainbow);
        p.color = Rgb {
            r: 1.0,
            g: 0.0,
            b: 0.0,
        }; // mono fallback
        p.brightness = 0.5;
        let f = p.frame(0.016);
        let lit: Vec<&Rgb> = f.iter().filter(|c| c.r + c.g + c.b > 0.01).collect();
        assert!(!lit.is_empty());
        // brightness caps everything at 0.5.
        assert!(f
            .iter()
            .all(|c| c.r <= 0.5 + 1e-6 && c.g <= 0.5 + 1e-6 && c.b <= 0.5 + 1e-6));
        // Rainbow: not all lit slots share the same colour.
        let first = lit[0];
        assert!(lit.iter().any(|c| {
            (c.r - first.r).abs() > 0.01
                || (c.g - first.g).abs() > 0.01
                || (c.b - first.b).abs() > 0.01
        }));
    }

    #[test]
    fn bitmap_art_and_background() {
        // 3×3 checkerboard bitmap on a 6×6 canvas, Cells mode.
        let pix = vec![
            255, 0, 255, //
            0, 255, 0, //
            255, 0, 255,
        ];
        let mut p = PixelArt::new(PixelArtSpec {
            art: ArtSource::bitmap(3, 3, pix),
            cols: 3,
            rows: 3,
            map: MapMode::Cells,
            background: Rgb {
                r: 0.1,
                g: 0.0,
                b: 0.0,
            },
            ..Default::default()
        });
        p.set_slots(9);
        let f = p.frame(0.0);
        assert_eq!(f.len(), 9);
        // Slot 0 (canvas 0,0) = strip(0,0)=255 lit; slot 1 = strip(1,0)=0 → background.
        assert!(f[0].r > 0.9);
        assert!((f[1].r - 0.1).abs() < 1e-6 && f[1].g == 0.0);
        // Centre cell (canvas 1,1) = strip(1,1) = 255 → full colour.
        assert!(f[4].r > 0.9 && f[4].g > 0.9 && f[4].b > 0.9);
    }

    #[test]
    fn empty_art_renders_background() {
        let mut p = PixelArt::new(PixelArtSpec::default());
        p.set_slots(10);
        let f = p.frame(0.016);
        assert_eq!(f.len(), 10);
        assert!(f.iter().all(|c| c.r == 0.0 && c.g == 0.0 && c.b == 0.0));
    }
}
