//! Live read-only check against a connected khub916 wired keyboard
//! (K1 Pro: VID 0x258A PID 0x010C, vendor interface usage page 0xFF00,
//! feature report id 6). Sends ONLY the query commands the vendor web
//! driver issues on connect — no writes.
//!
//! Run: `cargo run -p omg-proto-khub916 --example live_read`

use omg_hid::{find_devices, DeviceKind};
use omg_proto_khub916 as khub;

fn main() -> anyhow::Result<()> {
    let devices = find_devices()?;
    let wired: Vec<_> = devices.iter().filter(|d| d.kind == DeviceKind::Khub916Wired).collect();
    if wired.is_empty() {
        eprintln!("no khub916 wired device found ({} GravaStar interfaces seen)", devices.len());
        for d in &devices {
            eprintln!("  {} kind={:?} page=0x{:04x}", d.vid_pid(), d.kind, d.usage_page);
        }
        std::process::exit(2);
    }

    let mut last_err = None;
    for device in wired {
        eprintln!("trying {} (page 0x{:04x})", device.vid_pid(), device.usage_page);
        let mut link = match device.open_link() {
            Ok(l) => l,
            Err(e) => {
                eprintln!("  open failed: {e:#}");
                continue;
            }
        };
        let report_id = match khub::probe_report_id(&mut link) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("  report id probe failed: {e:#}");
                last_err = Some(e);
                continue;
            }
        };
        eprintln!("  feature report id: {report_id}");
        let mut kb = khub::Khub916::new(Box::new(link), report_id);

        let info = kb.device_info()?;
        println!("{}", serde_json::to_string_pretty(&info)?);

        let power = kb.power()?;
        println!("power: {}% flags=0x{:02x}", power.percent, power.flags);

        let keys = kb.keymap(0)?;
        println!("keymap: {} entries", keys.len());
        for (i, k) in keys.iter().take(16).enumerate() {
            println!("  [{i:3}] {}", if k.label().is_empty() { "—".into() } else { k.label() });
        }

        let profile = kb.profile()?;
        println!(
            "profile: {} bytes, light_mode={:?}, sleep={:?}s",
            profile.raw.len(),
            profile.light_mode(),
            profile.sleep_seconds()
        );

        let colors = kb.custom_light_colors()?;
        println!("custom light: {} entries, first={:?}", colors.len(), colors.first());

        let light = kb.light_color_data()?;
        println!("light color data: {} bytes", light.len());

        let mac = kb.macro_region()?;
        println!("macro region: {} bytes", mac.len());
        return Ok(());
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no khub916 device answered")))
}
