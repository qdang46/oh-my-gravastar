//! Device enumeration and GravaStar identity matching.
//!
//! Identity tables are taken from the official GravaStar Web HubX Pro device
//! tables (`docs/research/khub-webapp/index.js`, `916` / `916_wireLess`
//! protocol keys) and from `orbit-gravastar` protocol constants.

use std::path::Path;

use anyhow::{Context, Result};
use hidapi::HidApi;
use serde::Serialize;

use crate::link::HidLink;

// ── HE keyboard "v2" protocol ──────────────────────────────────────────
// orbit-gravastar/src/protocol/keyboard.rs

/// Vendor ids the official driver routes to the v2 (HE) protocol.
pub const HE_VIDS: [u16; 2] = [0x1ca6, 0x31e3];
pub const HE_USAGE_PAGE: u16 = 0xffb0;

/// Product ids the official web driver routes to the v2 (HE) protocol.
/// Kept as the decimal literals used upstream.
pub const HE_PIDS: [u16; 23] = [
    11272, 11273, 11282, 11275, 11276, 11288, 11289, 11296, 11297, 11290, 11291, 11292, 11293, 11274, 11278, 11277, 4896,
    11283, 11284, 11305, 11306, 11300, 11298,
];

// ── SparkPlayJoy 6x21 analog protocol ─────────────────────────────────
// HallJoy sparklink identities; matched on usage page + usage only.

pub const SPARKPLAYJOY_USAGE_PAGE: u16 = 0xffa0;
pub const SPARKPLAYJOY_USAGE: u16 = 1;

// ── Compx mice ─────────────────────────────────────────────────────────
// orbit-gravastar/src/protocol/mouse.rs

pub const MOUSE_VID: u16 = 0x3554;
pub const MOUSE_PIDS: [u16; 6] = [0xf54b, 0xf575, 0xf548, 0xf577, 0xf576, 0xf549];
pub const MOUSE_USAGE_PAGE: u16 = 0xff02;

// ── khub916 (K1 / K98 series, Web HubX Pro "916" protocol) ─────────────
// docs/research/khub-webapp/index.js device tables.
// VID 0x258A = 9610, VID 0x379A = 14234.

/// Wired identities from the `916` device table.
pub const KHUB916_WIRED: &[(u16, u16)] = &[
    (0x258a, 0x010c), // K1 Pro — "Gaming Keyboard" / "BY Tech"
    (0x258a, 0x019d),
    (0x258a, 0x0297),
    (0x258a, 0x02a5),
    (0x258a, 0x0296),
    (0x258a, 0x02dd),
    (0x258a, 0x02e9),
    (0x258a, 0x0293),
    (0x258a, 0x0294),
    (0x258a, 0x0295),
    (0x379a, 0xa001),
    (0x379a, 0xa000),
    (0x379a, 0xa004),
    (0x379a, 0xa008),
    (0x379a, 0xa005),
];

/// 2.4 GHz dongle identities from the `916_wireLess` device table
/// (duplicates removed). VID 0x3554 PID 0xfa09 is a wireless dongle and is
/// deliberately distinct from the wired Compx mouse PIDs.
pub const KHUB916_WIRELESS: &[(u16, u16)] = &[
    (0x3554, 0xfa09),
    (0x258a, 0x0150),
    (0x379a, 0xa002),
    (0x379a, 0xa009),
    (0x379a, 0xa006),
];

/// Which GravaStar protocol family a device belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    /// Mercury HE keyboards, "v2" 64-byte report protocol (usage page 0xffb0).
    HeKeyboardV2,
    /// SparkPlayJoy 6x21 analog protocol (usage page 0xffa0, usage 1).
    SparkPlayJoy,
    /// Compx-chipset mice (usage page 0xff02, report 0x08).
    CompxMouse,
    /// K1/K98 series over USB cable (Web HubX Pro "916" protocol).
    Khub916Wired,
    /// K1/K98 series over the 2.4 GHz dongle ("916_wireLess" protocol).
    Khub916Wireless,
}

impl DeviceKind {
    /// Short human-readable label.
    pub fn label(self) -> &'static str {
        match self {
            DeviceKind::HeKeyboardV2 => "HE keyboard (v2 protocol)",
            DeviceKind::SparkPlayJoy => "SparkPlayJoy analog interface",
            DeviceKind::CompxMouse => "Compx mouse",
            DeviceKind::Khub916Wired => "K1-series keyboard (khub916, wired)",
            DeviceKind::Khub916Wireless => "K1-series keyboard (khub916, 2.4 GHz)",
        }
    }
}

/// Classify a raw HID interface into a known GravaStar identity.
pub fn classify(vid: u16, pid: u16, usage_page: u16, usage: u16) -> Option<DeviceKind> {
    if HE_VIDS.contains(&vid) && HE_PIDS.contains(&pid) && usage_page == HE_USAGE_PAGE {
        return Some(DeviceKind::HeKeyboardV2);
    }
    if usage_page == SPARKPLAYJOY_USAGE_PAGE && usage == SPARKPLAYJOY_USAGE {
        return Some(DeviceKind::SparkPlayJoy);
    }
    if vid == MOUSE_VID && MOUSE_PIDS.contains(&pid) && usage_page == MOUSE_USAGE_PAGE {
        return Some(DeviceKind::CompxMouse);
    }
    if KHUB916_WIRED.contains(&(vid, pid)) {
        return Some(DeviceKind::Khub916Wired);
    }
    if KHUB916_WIRELESS.contains(&(vid, pid)) {
        return Some(DeviceKind::Khub916Wireless);
    }
    None
}

/// A detected GravaStar HID interface.
#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfo {
    /// Opaque OS path used to reopen the device.
    pub path: String,
    pub vid: u16,
    pub pid: u16,
    pub product: Option<String>,
    pub manufacturer: Option<String>,
    pub usage_page: u16,
    pub usage: u16,
    pub kind: DeviceKind,
}

impl DeviceInfo {
    /// `VID:PID` in hex, e.g. `258A:010C`.
    pub fn vid_pid(&self) -> String {
        format!("{:04X}:{:04X}", self.vid, self.pid)
    }

    /// Open this device as a [`HidLink`]. Compx mice use numbered reports.
    pub fn open_link(&self) -> Result<HidLink> {
        let api = HidApi::new().context("failed to initialise hidapi")?;
        let dev = api
            .open_path(Path::new(&self.path))
            .with_context(|| format!("failed to open HID device {}", self.vid_pid()))?;
        let numbered = self.kind == DeviceKind::CompxMouse;
        Ok(HidLink::new(dev, numbered))
    }
}

/// Enumerate all HID interfaces and keep only known GravaStar identities.
pub fn find_devices() -> Result<Vec<DeviceInfo>> {
    let api = HidApi::new().context("failed to initialise hidapi")?;
    api.refresh_devices()
        .context("failed to refresh HID device list")?;
    let mut out = Vec::new();
    for d in api.device_list() {
        let (vid, pid, page, usage) = (d.vendor_id(), d.product_id(), d.usage_page(), d.usage());
        let Some(kind) = classify(vid, pid, page, usage) else {
            continue;
        };
        out.push(DeviceInfo {
            path: d.path().to_string_lossy().into_owned(),
            vid,
            pid,
            product: d.product_string().map(str::to_string),
            manufacturer: d.manufacturer_string().map(str::to_string),
            usage_page: page,
            usage,
            kind,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khub916_wired_k1_pro_matches() {
        assert_eq!(classify(0x258a, 0x010c, 0, 0), Some(DeviceKind::Khub916Wired));
    }

    #[test]
    fn he_keyboard_matches() {
        assert_eq!(classify(0x1ca6, 11272, 0xffb0, 0), Some(DeviceKind::HeKeyboardV2));
        assert_eq!(classify(0x1ca6, 11272, 0xff02, 0), None);
    }

    #[test]
    fn mouse_and_wireless_do_not_collide() {
        assert_eq!(classify(0x3554, 0xf54b, 0xff02, 0), Some(DeviceKind::CompxMouse));
        assert_eq!(classify(0x3554, 0xfa09, 0, 0), Some(DeviceKind::Khub916Wireless));
    }

    #[test]
    fn sparkplayjoy_matches_on_usage() {
        assert_eq!(classify(0x1ca5, 0x2201, 0xffa0, 1), Some(DeviceKind::SparkPlayJoy));
        assert_eq!(classify(0x1ca5, 0x2201, 0xffa0, 2), None);
    }
}
