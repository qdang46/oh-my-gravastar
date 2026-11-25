//! Simulate BeatViz over a realistic loud-music Bands sequence and print
//! per-frame brightness stats — used to tune the ambient/beat balance
//! without needing eyes on the keyboard.

use omg_music::render::{BeatViz, FrameParams, FRAME_BYTES};
use omg_music::{Bands, BeatEvent, BeatKind};

fn stats(f: &[u8; FRAME_BYTES]) -> (f32, f32, u32) {
    let vals: Vec<u32> = f.iter().map(|&b| b as u32).collect();
    let mean = vals.iter().sum::<u32>() as f32 / vals.len() as f32 / 255.0;
    let lit = vals.iter().filter(|&&v| v > 24).count() as u32;
    (mean, *vals.iter().max().unwrap() as f32 / 255.0, lit)
}

fn main() {
    let bi: f32 = std::env::var("BI")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    let mut v = BeatViz::new(FrameParams {
        fps: 10.0,
        beat_intensity: bi,
        ..FrameParams::default()
    });
    // 140 BPM → beat every ~0.428 s. At 10 fps a beat lands ~every 4.3
    // frames. Simulate 12 s: loud music, kick every beat, hats between.
    let beat_period = 0.428_f32;
    let mut b = Bands {
        // Realistic spectrum: bass-heavy, mids varied, some quiet bins.
        spectrum: [
            0.75, 0.7, 0.55, 0.4, 0.3, 0.25, 0.35, 0.45, 0.5, 0.55, 0.5, 0.4, 0.35, 0.3, 0.3, 0.35,
            0.4, 0.45, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1,
        ],
        bass: 0.65,
        mid: 0.5,
        treble: 0.3,
        level: 0.72,
        agc: 1.3,
        bpm: 140.0,
        ..Bands::default()
    };
    // Isolation probe: ONE kick on a black field, no tempo/wash/pulse.
    {
        let mut v = BeatViz::new(FrameParams {
            fps: 10.0,
            ..FrameParams::default()
        });
        let mut b = Bands {
            events: vec![BeatEvent {
                kind: BeatKind::Kick,
                strength: 1.0,
            }],
            ..Default::default()
        };
        for f in 0..10 {
            let fr = v.frame(&b, f as f32 * 0.1);
            let (mean, max, lit) = stats(&fr);
            println!("probe kick-only f{f} mean={mean:.3} max={max:.2} lit={lit}");
            b.events.clear();
        }
    }
    let mut max_between = 0.0f32;
    let mut min_beat = 1.0f32;
    let mut t = 0.0f32;
    for frame in 0..120 {
        t += 0.1;
        let phase = (t / beat_period) % 1.0;
        b.beat_phase = if std::env::var("NOBOUNCE").is_ok() {
            0.0
        } else {
            phase
        };
        if std::env::var("NOBOUNCE").is_ok() {
            b.bpm = 0.0;
        }
        // beat pulse: set 1.0 on beat frames then decay 0.5/frame-ish
        // (PULSE_DECAY=5/s → ~0.5 per 0.1 s frame).
        let since_beat = (t % beat_period) / beat_period;
        b.beat_pulse = if std::env::var("NOPUNCH").is_ok() {
            0.0
        } else {
            (1.0 - since_beat * 2.4).max(0.0)
        };
        b.beat = since_beat < 0.12;
        b.events.clear();
        if b.beat {
            b.events.push(BeatEvent {
                kind: BeatKind::Kick,
                strength: 0.9,
            });
        } else if frame % 3 == 0 {
            b.events.push(BeatEvent {
                kind: BeatKind::HiHat,
                strength: 0.4,
            });
        }
        let f = v.frame(&b, t);
        let (mean, max, lit) = stats(&f);
        let plane = |lo: usize, hi: usize| {
            f[lo..hi].iter().map(|&x| x as u32).sum::<u32>() as f32 / ((hi - lo) as f32 * 255.0)
        };
        let tag = if b.beat { "BEAT " } else { "between" };
        println!(
            "{tag} f{frame:3} mean={mean:.3} max={max:.2} lit={lit} R={:.2} G={:.2} B={:.2}",
            plane(0, 126),
            plane(126, 252),
            plane(252, 378)
        );
        if !b.beat {
            max_between = max_between.max(mean);
        } else {
            min_beat = min_beat.min(mean);
        }
    }
    println!("--- max between-beat mean={max_between:.3}  min beat mean={min_beat:.3}");
}
