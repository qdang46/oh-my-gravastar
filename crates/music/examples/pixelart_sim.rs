//! Pixel-art sim: render [`PixelArt`] frames as ASCII/ANSI previews —
//! no hardware needed. Shows two mappings side by side:
//!
//! - `cells` — [`MapMode::Cells`] on a synthetic 22×6 slot-order matrix
//!   (canvas preview = the display itself).
//! - `keys`  — [`MapMode::Keys`] on a K1-Pro-like geometry (ANSI-ish
//!   126-slot layout ported from `omg kb916`'s `usage_cell` table),
//!   previewed as a keyboard-shaped ASCII board.
//!
//! Usage:
//!   cargo run -p omg-music --example pixelart_sim -- "TEXT"
//!   cargo run -p omg-music --example pixelart_sim -- --sprite
//!   cargo run -p omg-music --example pixelart_sim -- "MARQUEE" --scroll left --frames 120
//!
//! Flags: `--scroll left|right|static` (default left), `--frames N`
//! (default 90), `--fps F` stream rate for dt (default 30),
//! `--sprite` show a built-in 8×8 smiley bitmap instead of text,
//! `--no-color` plain ASCII.

use omg_music::pixelart::{ArtSource, MapMode, Motion, PixelArt, PixelArtSpec};
use omg_music::{grid_geometry, KeyPoint, Rgb};

const COLS: usize = 22;
const ROWS: usize = 6;
const SLOTS: usize = 126;

// ── K1-Pro-like geometry ───────────────────────────────────────────────
// Port of `usage_cell`/`MOD_CELLS` from crates/omg/src/kb916_music.rs:
// (x in key units 0…16.5, row 0…5). Kept in sync by hand — it is a sim
// fixture, not the live decoder.

fn usage_cell(usage: u16) -> Option<(f32, u8)> {
    let cell = match usage {
        0x29 => (0.5, 0),
        0x3A..=0x3D => (1.5 + (usage - 0x3A) as f32, 0),
        0x3E..=0x41 => (6.5 + (usage - 0x3E) as f32, 0),
        0x42..=0x45 => (11.5 + (usage - 0x42) as f32, 0),
        0x35 => (0.5, 1),
        0x1E..=0x27 => (1.5 + (usage - 0x1E) as f32, 1),
        0x2D => (11.5, 1),
        0x2E => (12.5, 1),
        0x2A => (14.3, 1),
        0x46 => (12.8, 1),
        0x47 => (13.8, 1),
        0x48 => (14.8, 1),
        0x4C => (11.6, 2),
        0x4D => (12.6, 2),
        0x4E => (13.6, 2),
        0x2B => (0.75, 2),
        0x14 => (2.0, 2),
        0x1A => (3.0, 2),
        0x08 => (4.0, 2),
        0x15 => (5.0, 2),
        0x17 => (6.0, 2),
        0x1C => (7.0, 2),
        0x18 => (8.0, 2),
        0x0C => (9.0, 2),
        0x12 => (10.0, 2),
        0x13 => (11.0, 2),
        0x2F => (12.0, 2),
        0x30 => (13.0, 2),
        0x31 => (14.0, 2),
        0x28 => (14.6, 2),
        0x39 => (0.9, 3),
        0x04 => (2.25, 3),
        0x16 => (3.25, 3),
        0x07 => (4.25, 3),
        0x09 => (5.25, 3),
        0x0A => (6.25, 3),
        0x0B => (7.25, 3),
        0x0D => (8.25, 3),
        0x0E => (9.25, 3),
        0x0F => (10.25, 3),
        0x33 => (11.25, 3),
        0x34 => (12.25, 3),
        0x1D => (2.75, 4),
        0x1B => (3.75, 4),
        0x06 => (4.75, 4),
        0x19 => (5.75, 4),
        0x05 => (6.75, 4),
        0x11 => (7.75, 4),
        0x10 => (8.75, 4),
        0x36 => (9.75, 4),
        0x37 => (10.75, 4),
        0x38 => (11.75, 4),
        0x49 => (11.6, 1),
        0x4A => (12.6, 1),
        0x4B => (13.6, 1),
        0x50 => (11.6, 4),
        0x52 => (12.6, 4),
        0x4F => (13.6, 4),
        0x51 => (12.6, 5),
        0x2C => (6.4, 5),
        0x65 => (12.0, 5),
        0x53 => (14.5, 1),
        0x57 => (14.0, 1),
        0x58 => (15.0, 1),
        0x59 => (16.0, 1),
        0x54 => (16.4, 2),
        0x5A => (14.0, 2),
        0x5B => (15.0, 2),
        0x5C => (16.0, 2),
        0x55 => (16.4, 3),
        0x5D => (14.0, 3),
        0x5E => (15.0, 3),
        0x5F => (16.0, 3),
        0x56 => (16.4, 4),
        0x60 => (14.5, 4),
        0x63 => (15.5, 4),
        _ => return None,
    };
    Some(cell)
}

const MOD_CELLS: [[(f32, u8); 2]; 4] = [
    [(0.6, 5), (13.2, 5)],
    [(1.1, 4), (13.6, 4)],
    [(2.75, 5), (9.7, 5)],
    [(1.75, 5), (10.6, 5)],
];

/// ~126-slot K1-Pro-ish geometry: ANSI usages + modifiers + filler
/// slots spread over the board (Fn/media/macro keys we can't place).
fn k1pro_geometry() -> Vec<KeyPoint> {
    let usages: &[u16] = &[
        0x29, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, // F row
        0x35, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2D, 0x2E, 0x2A,
        0x46, 0x47, 0x48, 0x49, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E,
        0x2B, 0x14, 0x1A, 0x08, 0x15, 0x17, 0x1C, 0x18, 0x0C, 0x12, 0x13, 0x2F, 0x30, 0x31,
        0x28, 0x39, 0x04, 0x16, 0x07, 0x09, 0x0A, 0x0B, 0x0D, 0x0E, 0x0F, 0x33, 0x34,
        0x1D, 0x1B, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x38,
        0x50, 0x52, 0x4F, 0x51, 0x2C, 0x65,
        0x53, 0x57, 0x58, 0x59, 0x54, 0x5A, 0x5B, 0x5C, 0x55, 0x5D, 0x5E, 0x5F, 0x56, 0x60,
        0x63,
    ];
    let mut pts: Vec<KeyPoint> = usages
        .iter()
        .filter_map(|&u| usage_cell(u))
        .map(|(x, y)| KeyPoint { x, y: y as f32 })
        .collect();
    // Modifier slots (Ctrl/Shift/Alt/GUI ×2 each) — approximated.
    for cells in MOD_CELLS {
        for &(x, y) in &cells {
            pts.push(KeyPoint { x, y: y as f32 });
        }
    }
    // Filler: unplaceable slots (Fn, macros, media) spread row-major so
    // total = 126 like the real device.
    let mut i = 0usize;
    while pts.len() < SLOTS {
        pts.push(KeyPoint {
            x: (i % 21) as f32 * 0.7 + 0.4,
            y: (i / 21) as f32,
        });
        i += 1;
    }
    pts.truncate(SLOTS);
    pts
}

// ── ANSI preview ───────────────────────────────────────────────────────

fn lit_char(c: Rgb, color: bool) -> String {
    let v = c.r + c.g + c.b;
    if v < 0.08 {
        return "·".to_string();
    }
    if !color {
        let ramp = " .:-=+*#%@";
        let idx = ((v / 3.0) * 9.0).round().clamp(0.0, 9.0) as usize;
        return ramp.chars().nth(idx).unwrap().to_string();
    }
    let r = (c.r.clamp(0.0, 1.0) * 255.0) as u8;
    let g = (c.g.clamp(0.0, 1.0) * 255.0) as u8;
    let b = (c.b.clamp(0.0, 1.0) * 255.0) as u8;
    format!("\x1b[38;2;{r};{g};{b}m█\x1b[0m")
}

/// Canvas preview: cols×rows grid, slot-order row-major.
fn print_canvas(frame: &[Rgb], cols: usize, rows: usize, color: bool) {
    for r in 0..rows {
        let mut line = String::new();
        for c in 0..cols {
            let i = r * cols + c;
            line.push_str(&lit_char(*frame.get(i).unwrap_or(&Rgb::BLACK), color));
        }
        println!("  {line}");
    }
}

/// Keyboard preview: scatter slots onto a 17×6 board by x,y.
fn print_keyboard(geom: &[KeyPoint], frame: &[Rgb], color: bool) {
    const KW: usize = 17;
    const KH: usize = 6;
    let mut board = vec![Rgb::BLACK; KW * KH];
    let mut seen = [false; KW * KH];
    for (i, k) in geom.iter().enumerate() {
        let cx = ((k.x / 16.5) * (KW - 1) as f32).round() as usize;
        let cy = (k.y.round() as usize).min(KH - 1);
        let idx = cy * KW + cx.min(KW - 1);
        // First slot wins a board cell (collisions are common at this
        // resolution — it's a preview, not the real mapping).
        if !seen[idx] {
            seen[idx] = true;
            board[idx] = frame.get(i).copied().unwrap_or(Rgb::BLACK);
        }
    }
    for r in 0..KH {
        let mut line = String::new();
        for c in 0..KW {
            line.push_str(&lit_char(board[r * KW + c], color));
        }
        println!("  {line}");
    }
}

// ── Built-in sprite ────────────────────────────────────────────────────

fn smiley() -> Vec<u8> {
    const ROWS: [&str; 8] = [
        ".######.",
        "#......#",
        "#.#..#.#",
        "#.#..#.#",
        "#......#",
        "#.####.#",
        "#......#",
        ".######.",
    ];
    ROWS.iter()
        .flat_map(|r| r.bytes().map(|b| if b == b'#' { 255 } else { 0 }))
        .collect()
}

// ── main ───────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut text = "OMG".to_string();
    let mut scroll = Motion::ScrollLeft;
    let mut frames = 90usize;
    let mut fps = 30.0f32;
    let mut sprite = false;
    let mut color = std::env::var_os("NO_COLOR").is_none();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scroll" => {
                i += 1;
                scroll = match args.get(i).map(|s| s.as_str()) {
                    Some("left") => Motion::ScrollLeft,
                    Some("right") => Motion::ScrollRight,
                    _ => Motion::Static,
                };
            }
            "--frames" => {
                i += 1;
                frames = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(90);
            }
            "--fps" => {
                i += 1;
                fps = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(30.0);
            }
            "--sprite" => sprite = true,
            "--no-color" => color = false,
            s if !s.starts_with("--") => text = s.to_string(),
            _ => {}
        }
        i += 1;
    }

    let art = if sprite {
        ArtSource::bitmap(8, 8, smiley())
    } else {
        ArtSource::text(text.clone())
    };
    let spec = |map| PixelArtSpec {
        art: art.clone(),
        cols: COLS,
        rows: ROWS,
        motion: scroll,
        repeat: true,
        speed: 5.0,
        color: Rgb { r: 1.0, g: 0.55, b: 0.15 },
        palette: if sprite { None } else { Some(omg_music::Palette::Rainbow) },
        map,
        ..Default::default()
    };

    let mut cells = PixelArt::new(spec(MapMode::Cells));
    cells.set_slots(SLOTS);
    let mut keys = PixelArt::new(spec(MapMode::Keys));
    let k1 = k1pro_geometry();
    keys.set_geometry(&k1);
    let mut keys_uniform = PixelArt::new(spec(MapMode::Keys));
    let uniform = grid_geometry(SLOTS);
    keys_uniform.set_geometry(&uniform);

    println!("pixelart sim — art={:?} motion={scroll:?} canvas={COLS}x{ROWS} slots={SLOTS} fps={fps}",
        if sprite { "sprite".to_string() } else { format!("'{text}'") });
    println!("legend: · = dark, brightness → colour (ANSI truecolor unless --no-color)");

    let dt = 1.0 / fps;
    // Print every 6th frame (~5 previews/sec at 30 fps).
    for f in 0..frames {
        let cf = cells.frame(dt);
        let kf = keys.frame(dt);
        let uf = keys_uniform.frame(dt);
        if f % 6 != 0 {
            continue;
        }
        println!("\n── frame {f:>3} t={:.2}s ──────────────────────────────", f as f32 * dt);
        println!(" cells (slot-order {COLS}x{ROWS}):");
        print_canvas(&cf, COLS, ROWS, color);
        println!(" keys @ K1-Pro-like geometry:");
        print_keyboard(&k1, &kf, color);
        println!(" keys @ uniform grid fallback:");
        print_keyboard(&uniform, &uf, color);
    }
}
