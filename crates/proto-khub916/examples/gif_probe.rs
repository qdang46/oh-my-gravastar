//! Live diagnostic for khub916 cmd 8 (GIF light frames) — TEST-001 helper.
//!
//! Opens the wired khub916 device, sends ONE cmd-8 packet via
//! `feature_exchange` (send + read reply) and prints whatever the firmware
//! answers. Config writes are normally fire-and-forget, so this probe only
//! checks whether the device recognises/echoes the command — it does not
//! prove the LEDs changed (that needs eyes on the keyboard).
//!
//! Usage: `cargo run -p omg-proto-khub916 --example gif_probe [--exchange|--write] [--frames N] [--fps F]`
//!   --exchange  feature_exchange per packet (default): shows any reply
//!   --write     feature_write per packet (vendor path, fire-and-forget)

use std::time::Duration;

use anyhow::{bail, Result};
use omg_hid::{find_devices, DeviceKind, Link};
use omg_proto_khub916::light::{GIF_FRAME_BYTES, GIF_FRAME_PREFIX};
use omg_proto_khub916::{probe_report_id, FEATURE_PAYLOAD_BYTES};

const HEADER_LEN: usize = 7;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let exchange = !args.iter().any(|a| a == "--write");
    let frames: usize = args
        .iter()
        .position(|a| a == "--frames")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let fps: f64 = args
        .iter()
        .position(|a| a == "--fps")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(30.0);

    let devices = find_devices()?;
    let device = devices
        .iter()
        .find(|d| d.kind == DeviceKind::Khub916Wired)
        .ok_or_else(|| anyhow::anyhow!("no wired khub916 device found"))?;
    println!("device: {} {}", device.vid_pid(), device.path);

    let mut link = device.open_link()?;
    let report_id = probe_report_id(&mut link)?;
    println!("report_id: {report_id}");

    // Solid-colour frame: planar [R×126][G×126][B×126].
    // --color rrggbb|r,g,b (default ff0000 red).
    let (r, g, b) = {
        let c = args.iter().position(|a| a == "--color")
            .and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| "ff0000".into());
        let c = c.trim_start_matches('#');
        if c.len() == 6 {
            let v = u32::from_str_radix(c, 16).unwrap();
            ((v >> 16) as u8, (v >> 8) as u8, v as u8)
        } else {
            let p: Vec<u8> = c.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            (p[0], p[1], p[2])
        }
    };
    println!("frame colour: #{r:02x}{g:02x}{b:02x}");
    let mut frame = vec![0u8; GIF_FRAME_BYTES];
    for i in 0..126 {
        frame[i] = r;
        frame[126 + i] = g;
        frame[252 + i] = b;
    }

    let period = Duration::from_secs_f64(1.0 / fps);
    for i in 0..frames {
        let pkt = Khub916Probe::packet(&frame)?;
        if exchange {
            match link.feature_exchange(report_id, &pkt, Duration::from_millis(500)) {
                Ok(Some(resp)) => {
                    println!("frame {i}: reply {} bytes", resp.len());
                    if std::env::var("GIF_PROBE_DUMP").is_ok() {
                        for (j, chunk) in resp.chunks(32).enumerate() {
                            println!("  {:04x}: {}", j*32, chunk.iter().map(|b| format!("{b:02x}")).collect::<String>());
                        }
                    } else {
                        println!("  head: {:02x?}", &resp[..resp.len().min(32)]);
                    }
                }
                Ok(None) => println!("frame {i}: no answer"),
                Err(e) => println!("frame {i}: exchange error: {e:#}"),
            }
        } else {
            link.feature_write(report_id, &pkt)?;
            println!("frame {i}: written");
        }
        if i + 1 < frames {
            std::thread::sleep(period);
        }
    }
    Ok(())
}

/// Packet builder mirroring `Khub916::gif_frame_packet` (private-session
/// path can't be reached without a full session; identical layout).
struct Khub916Probe;

impl Khub916Probe {
    fn packet(data: &[u8]) -> Result<[u8; FEATURE_PAYLOAD_BYTES]> {
        if data.len() > GIF_FRAME_BYTES {
            bail!("frame too large");
        }
        let mut pkt = [0u8; FEATURE_PAYLOAD_BYTES];
        pkt[..HEADER_LEN].copy_from_slice(&GIF_FRAME_PREFIX);
        pkt[HEADER_LEN..HEADER_LEN + data.len()].copy_from_slice(data);
        Ok(pkt)
    }
}
