use omg_music::{Bands, VendorEngine, VendorLayer, SPECTRUM_BINS};

fn run(layers: Vec<VendorLayer>, label: &str) {
    let mut eng = VendorEngine::default();
    eng.layers = layers.into_iter().map(|l| (l, None)).collect();
    let mut b = Bands::default();
    b.spectrum = [0.4; SPECTRUM_BINS];
    b.mid = 0.3; b.treble = 0.2;
    let mut floor = 0.0f32;
    let mut peak = 0.0f32;
    for i in 0..300 {
        let phase = i % 25;
        b.bass = if phase == 0 { 0.9 } else { 0.9 * (-phase as f32 / 6.0).exp() };
        b.level = b.bass * 0.7 + 0.05;
        b.beat = phase == 0;
        let f = eng.frame(&b, 0.02, &[]);
        let mean = f.iter().map(|&v| v as f32).sum::<f32>() / (378.0 * 255.0);
        if phase == 24 { floor = mean; }
        if phase <= 2 { peak = peak.max(mean); }
    }
    println!("{label:20} floor={floor:.3} peak={peak:.3}");
}

fn main() {
    run(vec![VendorLayer::Pulse], "pulse only");
    run(vec![VendorLayer::Ripple], "ripple only");
    run(vec![VendorLayer::Spectrum], "spectrum only");
    run(vec![VendorLayer::Rain], "rain only");
    run(vec![VendorLayer::Pulse, VendorLayer::Ripple], "pulse+ripple (default)");
    run(vec![VendorLayer::Spectrum, VendorLayer::Ripple, VendorLayer::Pulse], "spec+rip+pulse");
}
