//! `omg kb916 doctor fn` — read-only Fn-layer diagnostic for the
//! "Fn+X does nothing" symptom (bead oh-my-gravastar-x2q, CLI half of
//! the web fn-layer-doctor).
//!
//! Mirrors `web/src/fn-doctor-core.ts` exactly: it reads the keymap arg
//! `0x01` (Fn layer) and arg `0x00` (base layer) through the existing
//! cmd-131 read path ([`Khub916::key_values`]), then reports:
//!
//!   1. physical keys whose Fn-layer slot is `0x00000000` (no Fn action),
//!   2. slots whose value decodes to an unknown tag (opaque per
//!      AGENTS.md §Safety 7 — e.g. the undocumented tag-`0x08` Fn actions
//!      on the K1 Pro; counted, never "fixed"),
//!   3. the Fn key's base-layer binding (`fn` / `empty` / `rebound` /
//!      `unreadable` / `no-layout`).
//!
//! READ-ONLY contract: this module sends nothing itself — the command
//! handler performs two cmd-131 queries. There is deliberately no fix
//! path and nothing near cmd-17 reset (AGENTS.md §Safety 2). A bad
//! verdict is still exit 0: this is a diagnostic, not a failure — exit
//! codes 1/2/3 remain reserved for errors, no-device and unsupported
//! per docs/plan.md.

use std::collections::BTreeMap;

use anyhow::Result;
use omg_hid::DeviceInfo;
use omg_proto_khub916 as khub;
use serde::Serialize;
use serde_json::json;

use crate::{print_json, Cli};

// ── Keymap arguments (spec §6 arg packing: layer&3 | system<<2) ────────

/// Keymap arg of the Fn layer: `layer 1 | system 0`.
pub(crate) const FN_LAYER_ARG: u8 = 0x01;
/// Keymap arg of the base (primary) layer the Fn key lives on.
pub(crate) const BASE_LAYER_ARG: u8 = 0x00;

// ── Physical slot → key-name table ─────────────────────────────────────
//
// Ported subset of `web/src/layout-tables.ts` `"916_K1_PRO"` (vendor
// `keycodeConfig/keyboard_916_K1_PRO.json`, docs/research/khub-webapp).
// Only `display:1` rows — physical keys — are kept; `pos = 8 + n*4`
// gives the keymap slot index n. The full 14-table vendor set is NOT
// ported (67 KB of geometry we do not need); other catalog models get
// honest slot indices instead of names.
//
// (slot index, factory legend)
const K1_PRO_PHYSICAL: &[(u16, &str)] = &[
    (0, "ESC"),
    (1, "`~"),
    (2, "Tab"),
    (3, "Caps"),
    (4, "L_shift"),
    (5, "L_Ctrl"),
    (7, "1"),
    (8, "Q"),
    (9, "A"),
    (11, "L_WIN"),
    (12, "F1"),
    (13, "2"),
    (14, "W"),
    (15, "S"),
    (16, "Z"),
    (17, "L_Alt"),
    (18, "F2"),
    (19, "3"),
    (20, "E"),
    (21, "D"),
    (22, "X"),
    (24, "F3"),
    (25, "4"),
    (26, "R"),
    (27, "F"),
    (28, "C"),
    (30, "F4"),
    (31, "5"),
    (32, "T"),
    (33, "G"),
    (34, "V"),
    (35, "Space"),
    (36, "F5"),
    (37, "6"),
    (38, "Y"),
    (39, "H"),
    (40, "B"),
    (42, "F6"),
    (43, "7"),
    (44, "U"),
    (45, "J"),
    (46, "N"),
    (48, "F7"),
    (49, "8"),
    (50, "I"),
    (51, "K"),
    (52, "M"),
    (53, "R_Alt"),
    (54, "F8"),
    (55, "9"),
    (56, "O"),
    (57, "L"),
    (58, "<,"),
    (59, "Fn"),
    (60, "F9"),
    (61, "0"),
    (62, "P"),
    (63, ":;"),
    (64, ">."),
    (66, "F10"),
    (67, "-_"),
    (68, "[{"),
    (69, "'"),
    (70, "/?"),
    (72, "F11"),
    (73, "=+"),
    (74, "]}"),
    (78, "F12"),
    (79, "Back"),
    (80, "|"),
    (81, "Enter"),
    (82, "R_shift"),
    (83, "left"),
    (88, "Up"),
    (89, "Down"),
    (91, "Del"),
    (92, "PgUp"),
    (93, "PgDn"),
    (95, "right"),
];

/// Physical-layout knowledge for one catalog model: slot → display name
/// plus the Fn key's slot (derived from the table's `"Fn"` row, never
/// hardcoded — same rule as the web `fn-doctor.ts`).
pub(crate) struct FnLayout {
    pub(crate) physical: BTreeMap<usize, String>,
    pub(crate) fn_key_index: usize,
    pub(crate) fn_key_name: String,
}

/// Layout table for a `device_info().catalog_model`. Only the K1 Pro
/// ANSI table is ported; every other model gets `None` and the report
/// falls back to slot indices (`no-layout` Fn-key status).
pub(crate) fn layout_for_model(model: Option<&str>) -> Option<FnLayout> {
    if model != Some("916_K1_PRO") {
        return None;
    }
    let mut physical = BTreeMap::new();
    let mut fn_key_index = None;
    let mut fn_key_name = None;
    for &(idx, name) in K1_PRO_PHYSICAL {
        let i = idx as usize;
        let label = if name.is_empty() {
            format!("slot {i}")
        } else {
            name.to_string()
        };
        physical.insert(i, label.clone());
        if fn_key_index.is_none() && name.eq_ignore_ascii_case("fn") {
            fn_key_index = Some(i);
            fn_key_name = Some(label);
        }
    }
    Some(FnLayout {
        physical,
        fn_key_index: fn_key_index?,
        fn_key_name: fn_key_name?,
    })
}

// ── Report types (mirror web/src/fn-doctor-core.ts field-for-field) ────

/// One flagged keymap slot.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FnDoctorSlot {
    /// Keymap table index (0-based slot number).
    pub(crate) index: usize,
    /// Physical key name when a layout table knows it, else `slot <n>`.
    pub(crate) name: String,
    /// Raw u32 keymap value.
    pub(crate) value: u32,
}

/// Fn-key base-layer binding status (web `FnKeyStatus`, kebab-case).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FnKeyStatus {
    /// Base-layer slot decodes to an `fn` layer switch — Fn key is bound.
    Fn,
    /// Slot reads `0x00000000` — the Fn key lost its binding.
    Empty,
    /// Slot holds a non-Fn value — the key was rebound to something else.
    Rebound,
    /// Base-layer table missing/too short to contain the slot.
    Unreadable,
    /// No layout table for this model — the Fn key position is unknown.
    NoLayout,
}

/// Fn-key cross-check result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FnDoctorFnKey {
    pub(crate) index: Option<usize>,
    pub(crate) name: Option<String>,
    pub(crate) base_value: Option<u32>,
    pub(crate) status: FnKeyStatus,
    /// Human label of `base_value` for `rebound` (e.g. `Macro(…)`).
    pub(crate) label: Option<String>,
}

/// The full diagnostic report — same shape as web `FnDoctorReport`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FnDoctorReport {
    pub(crate) fn_arg: u8,
    pub(crate) base_arg: u8,
    pub(crate) slot_count: usize,
    /// Physical keys (or every slot when no layout) whose Fn-layer value
    /// is `0x00000000` — no Fn action.
    pub(crate) dead: Vec<FnDoctorSlot>,
    /// Slots whose value decodes to an unknown tag — opaque per §Safety 7.
    pub(crate) opaque: Vec<FnDoctorSlot>,
    pub(crate) fn_key: FnDoctorFnKey,
    /// No dead slots and the Fn key (when its position is known) still
    /// decodes to `fn`. Opaque slots and an unverifiable Fn key do NOT
    /// break `intact` — same rule as the web core.
    pub(crate) intact: bool,
    /// One-line verdict.
    pub(crate) summary: String,
}

fn slot_name(physical: Option<&BTreeMap<usize, String>>, index: usize) -> String {
    physical
        .and_then(|m| m.get(&index).cloned())
        .unwrap_or_else(|| format!("slot {index}"))
}

/// True when a keymap u32 decodes to a tag the protocol does not name —
/// port of web `isOpaqueKeymapValue` (keymap-guard.ts). `0` (empty) and
/// every documented tag are NOT opaque.
fn is_opaque(v: u32) -> bool {
    v != 0 && matches!(khub::decode_key_value(v), khub::KeyValue::Unknown { .. })
}

/// Analyse the Fn layer (`fn_values`, arg `0x01`) against the base layer
/// (`base_values`, arg `0x00`). Both are raw u32 tables in slot order;
/// `base_values` may be shorter/empty — the Fn-key check then reports
/// `unreadable`/`no-layout` instead of guessing. Pure: no device access.
pub(crate) fn analyze_fn_layer(
    fn_values: &[u32],
    base_values: &[u32],
    layout: Option<&FnLayout>,
) -> FnDoctorReport {
    let physical = layout.map(|l| &l.physical);

    // Candidate slots for the "no Fn action" check: the physical keys
    // when a layout table exists, otherwise every slot in the read
    // (honest over-approximation, same as the web core).
    let mut candidates: Vec<usize> = match physical {
        Some(m) => m.keys().copied().filter(|&i| i < fn_values.len()).collect(),
        None => (0..fn_values.len()).collect(),
    };
    candidates.sort_unstable();

    let mut dead = Vec::new();
    for i in candidates {
        if fn_values[i] == 0 {
            dead.push(FnDoctorSlot {
                index: i,
                name: slot_name(physical, i),
                value: 0,
            });
        }
    }

    let mut opaque = Vec::new();
    for (i, &v) in fn_values.iter().enumerate() {
        if is_opaque(v) {
            opaque.push(FnDoctorSlot {
                index: i,
                name: slot_name(physical, i),
                value: v,
            });
        }
    }

    // ── Fn key cross-check (base layer arg 0x00) ─────────────────────
    let fn_key = match layout {
        None => FnDoctorFnKey {
            index: None,
            name: None,
            base_value: None,
            status: FnKeyStatus::NoLayout,
            label: None,
        },
        Some(l) => {
            let i = l.fn_key_index;
            if i >= base_values.len() {
                FnDoctorFnKey {
                    index: Some(i),
                    name: Some(l.fn_key_name.clone()),
                    base_value: None,
                    status: FnKeyStatus::Unreadable,
                    label: None,
                }
            } else {
                let v = base_values[i];
                match khub::decode_key_value(v) {
                    khub::KeyValue::Fn { .. } => FnDoctorFnKey {
                        index: Some(i),
                        name: Some(l.fn_key_name.clone()),
                        base_value: Some(v),
                        status: FnKeyStatus::Fn,
                        label: None,
                    },
                    khub::KeyValue::Empty => FnDoctorFnKey {
                        index: Some(i),
                        name: Some(l.fn_key_name.clone()),
                        base_value: Some(v),
                        status: FnKeyStatus::Empty,
                        label: None,
                    },
                    other => FnDoctorFnKey {
                        index: Some(i),
                        name: Some(l.fn_key_name.clone()),
                        base_value: Some(v),
                        status: FnKeyStatus::Rebound,
                        label: Some(other.label()),
                    },
                }
            }
        }
    };

    let fn_key_bad = matches!(fn_key.status, FnKeyStatus::Empty | FnKeyStatus::Rebound);
    let intact = dead.is_empty() && !fn_key_bad;

    let mut report = FnDoctorReport {
        fn_arg: FN_LAYER_ARG,
        base_arg: BASE_LAYER_ARG,
        slot_count: fn_values.len(),
        dead,
        opaque,
        fn_key,
        intact,
        summary: String::new(),
    };
    report.summary = fn_doctor_summary(&report);
    report
}

const SUMMARY_NAME_CAP: usize = 12;

fn slot_list(names: &[String]) -> String {
    if names.len() <= SUMMARY_NAME_CAP {
        names.join(", ")
    } else {
        format!(
            "{}, +{} more",
            names[..SUMMARY_NAME_CAP].join(", "),
            names.len() - SUMMARY_NAME_CAP
        )
    }
}

/// One-line verdict — port of web `fnDoctorSummary`.
fn fn_doctor_summary(r: &FnDoctorReport) -> String {
    let mut problems: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if !r.dead.is_empty() {
        let names: Vec<String> = r.dead.iter().map(|s| s.name.clone()).collect();
        problems.push(format!(
            "{} key{} no Fn action: {}",
            r.dead.len(),
            if r.dead.len() == 1 { " has" } else { "s have" },
            slot_list(&names)
        ));
    }
    let fn_display = r
        .fn_key
        .name
        .clone()
        .unwrap_or_else(|| format!("slot {}", r.fn_key.index.unwrap_or(0)));
    match r.fn_key.status {
        FnKeyStatus::Empty => problems.push(format!(
            "the Fn key ({fn_display}) has no binding in the base layer"
        )),
        FnKeyStatus::Rebound => problems.push(format!(
            "the Fn key ({fn_display}) is rebound to {} — it no longer switches to the Fn layer",
            r.fn_key.label.clone().unwrap_or_else(|| "something else".into())
        )),
        FnKeyStatus::Unreadable => {
            notes.push("the Fn key could not be checked — the base layer read was incomplete".into())
        }
        FnKeyStatus::NoLayout => {
            notes.push("the Fn key position is unknown for this model (no layout table)".into())
        }
        FnKeyStatus::Fn => {}
    }
    if !r.opaque.is_empty() {
        notes.push(format!(
            "{} slot{} carry opaque/unknown values the app cannot decode (preserved as-is)",
            r.opaque.len(),
            if r.opaque.len() == 1 { "" } else { "s" }
        ));
    }
    if problems.is_empty() {
        let verdict = "Fn layer intact".to_string();
        if notes.is_empty() {
            verdict
        } else {
            format!("{verdict} ({})", notes.join("; "))
        }
    } else {
        problems.extend(notes);
        problems.join("; ")
    }
}

// ── Command ────────────────────────────────────────────────────────────

/// `omg kb916 doctor fn` — analysis + rendering of two keymap reads the
/// caller already performed (arg `0x01` Fn layer, arg `0x00` base layer)
/// through the cmd-131 read path. `catalog_model` is
/// `device_info().catalog_model` (`None` = UUID not in the vendor
/// catalog). Exit 0 on a successful read even when the verdict is bad —
/// a diagnostic is not a failure (documented choice; exit 2/3 stay
/// reserved for no-device / unsupported per docs/plan.md).
pub(crate) fn cmd(
    cli: &Cli,
    device: &DeviceInfo,
    catalog_model: Option<&str>,
    fn_values: &[u32],
    base_values: &[u32],
) -> Result<()> {
    let layout = layout_for_model(catalog_model);
    let report = analyze_fn_layer(fn_values, base_values, layout.as_ref());
    let model_json = catalog_model.map(|m| m.to_string());
    if cli.json {
        print_json(&json!({
            "device": device,
            "model": model_json,
            "layout": layout.is_some(),
            "fn_doctor": report,
        }))?;
    } else {
        println!("Fn-layer doctor (read-only: keymap arg 0x01 vs 0x00)");
        match catalog_model {
            Some(m) if layout.is_some() => println!("model: {m} (K1 Pro layout table)"),
            Some(m) => println!("model: {m} (no layout table — slot indices only)"),
            None => println!("model: unknown (no layout table — slot indices only)"),
        }
        println!("verdict: {}", report.summary);
        if !report.dead.is_empty() {
            println!("keys with no Fn action:");
            for s in &report.dead {
                println!("  [{:3}] {} — 0x00000000", s.index, s.name);
            }
        }
        if !report.opaque.is_empty() {
            println!(
                "{} slot{} carry opaque/unknown values (preserved as-is):",
                report.opaque.len(),
                if report.opaque.len() == 1 { "" } else { "s" }
            );
            for s in &report.opaque {
                println!("  [{:3}] {} — 0x{:08X}", s.index, s.name, s.value);
            }
        }
        let fk = &report.fn_key;
        let fk_name = fk
            .name
            .clone()
            .unwrap_or_else(|| format!("slot {}", fk.index.unwrap_or(0)));
        match fk.status {
            FnKeyStatus::Fn => println!(
                "Fn key check: {fk_name} still switches to the Fn layer (arg 0x00)"
            ),
            FnKeyStatus::Empty => println!(
                "Fn key check: {fk_name} reads 0x00000000 in the base layer — no binding at all"
            ),
            FnKeyStatus::Rebound => println!(
                "Fn key check: {fk_name} is bound to {} instead of the Fn layer",
                fk.label.clone().unwrap_or_else(|| "something else".into())
            ),
            FnKeyStatus::Unreadable => println!(
                "Fn key check: could not read base-layer slot {} (incomplete read)",
                fk.index.unwrap_or(0)
            ),
            FnKeyStatus::NoLayout => println!(
                "Fn key check: skipped — no layout table for this model"
            ),
        }
        println!("read {} slots; this check sends queries only, never writes", report.slot_count);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> FnLayout {
        layout_for_model(Some("916_K1_PRO")).expect("K1 Pro layout")
    }

    fn full_fn_layer(dead: &[usize]) -> Vec<u32> {
        // Every slot bound to a benign normal key except the dead ones.
        let mut v = vec![0x0000_0004u32; 126]; // HID 'a'
        for &i in dead {
            v[i] = 0;
        }
        v
    }

    fn base_layer() -> Vec<u32> {
        let mut v = vec![0x0000_0004u32; 126];
        v[59] = 0x0D00_0000; // Fn key → Fn layer switch
        v
    }

    #[test]
    fn intact_layer_reports_clean() {
        let r = analyze_fn_layer(&full_fn_layer(&[]), &base_layer(), Some(&layout()));
        assert!(r.intact);
        assert_eq!(r.summary, "Fn layer intact");
        assert!(r.dead.is_empty());
        assert_eq!(r.fn_key.status, FnKeyStatus::Fn);
        assert_eq!(r.fn_key.index, Some(59));
        assert_eq!(r.fn_key.name.as_deref(), Some("Fn"));
        assert_eq!(r.slot_count, 126);
        assert_eq!(r.fn_arg, 0x01);
        assert_eq!(r.base_arg, 0x00);
    }

    #[test]
    fn dead_physical_slots_are_listed_by_name() {
        // Slots 7 ('1') and 35 ('Space') lose their Fn action.
        let r = analyze_fn_layer(&full_fn_layer(&[7, 35]), &base_layer(), Some(&layout()));
        assert!(!r.intact);
        assert_eq!(r.dead.len(), 2);
        assert_eq!(r.dead[0].name, "1");
        assert_eq!(r.dead[1].name, "Space");
        assert!(r.summary.contains("2 keys have no Fn action"));
        assert!(r.summary.contains("1, Space"));
    }

    #[test]
    fn nonphysical_dead_slots_are_ignored_with_layout() {
        // Slot 6 is a display:false aux slot — not a physical key, so a
        // zero there must not count as a dead Fn action.
        let mut fnv = full_fn_layer(&[]);
        fnv[6] = 0;
        let r = analyze_fn_layer(&fnv, &base_layer(), Some(&layout()));
        assert!(r.dead.is_empty());
        assert!(r.intact);
    }

    #[test]
    fn without_layout_every_slot_is_a_candidate() {
        let mut fnv = full_fn_layer(&[]);
        fnv[6] = 0;
        fnv[100] = 0;
        let r = analyze_fn_layer(&fnv, &base_layer(), None);
        assert_eq!(r.dead.len(), 2);
        assert_eq!(r.dead[0].name, "slot 6");
        assert_eq!(r.dead[1].name, "slot 100");
        assert_eq!(r.fn_key.status, FnKeyStatus::NoLayout);
        assert!(!r.intact); // dead slots still break intact
        assert!(r.summary.contains("no layout table"));
    }

    #[test]
    fn opaque_slots_flagged_not_dead() {
        // Tag 0x08 = undocumented Fn-action tag (spec §tag-0x08); tag
        // 0x20 = documented SOCD — opaque must catch only the former.
        let mut fnv = full_fn_layer(&[]);
        fnv[12] = 0x0800_0001; // opaque (unknown tag)
        fnv[13] = 0x2000_0001; // SOCD — known, not opaque
        fnv[14] = 0x0D01_0000; // Fn1 — known
        let r = analyze_fn_layer(&fnv, &base_layer(), Some(&layout()));
        assert_eq!(r.opaque.len(), 1);
        assert_eq!(r.opaque[0].index, 12);
        assert_eq!(r.opaque[0].name, "F1");
        assert_eq!(r.opaque[0].value, 0x0800_0001);
        assert!(r.dead.is_empty());
        assert!(r.intact); // opaque does not break intact
        assert!(r.summary.contains("1 slot carry opaque/unknown"));
    }

    #[test]
    fn fn_key_empty_and_rebound_break_intact() {
        // Empty binding.
        let mut base = base_layer();
        base[59] = 0;
        let r = analyze_fn_layer(&full_fn_layer(&[]), &base, Some(&layout()));
        assert_eq!(r.fn_key.status, FnKeyStatus::Empty);
        assert!(!r.intact);
        assert!(r.summary.contains("has no binding in the base layer"));

        // Rebound to a macro.
        let mut base = base_layer();
        base[59] = 0x0301_0203; // tag 0x03 macro
        let r = analyze_fn_layer(&full_fn_layer(&[]), &base, Some(&layout()));
        assert_eq!(r.fn_key.status, FnKeyStatus::Rebound);
        assert_eq!(r.fn_key.label.as_deref(), Some("Macro(1,2,3)"));
        assert!(!r.intact);
        assert!(r.summary.contains("rebound to Macro(1,2,3)"));
    }

    #[test]
    fn short_base_read_reports_unreadable() {
        let base = vec![0x0D00_0000u32; 10]; // Fn slot 59 not covered
        let r = analyze_fn_layer(&full_fn_layer(&[]), &base, Some(&layout()));
        assert_eq!(r.fn_key.status, FnKeyStatus::Unreadable);
        assert!(r.intact); // unverifiable Fn key does not break intact
        assert!(r.summary.contains("Fn layer intact"));
        assert!(r.summary.contains("could not be checked"));
    }

    #[test]
    fn only_k1_pro_gets_names() {
        assert!(layout_for_model(Some("916_K1_PRO")).is_some());
        for m in [
            "916_K1",
            "916_K1_PRO_DE",
            "916_K98Pro",
            "916_K1_LITE",
            "916_GravaStar_Mercury_NP",
        ] {
            assert!(layout_for_model(Some(m)).is_none(), "{m}");
        }
        assert!(layout_for_model(None).is_none());
    }

    #[test]
    fn summary_caps_long_name_lists() {
        // 20 dead physical slots → summary truncates at 12 names.
        let l = layout();
        let dead: Vec<usize> = l.physical.keys().copied().take(20).collect();
        let r = analyze_fn_layer(&full_fn_layer(&dead), &base_layer(), Some(&l));
        assert!(r.dead.len() > 12);
        assert!(r.summary.contains("+8 more"));
    }

    #[test]
    fn report_serializes_camel_case() {
        let r = analyze_fn_layer(&full_fn_layer(&[7]), &base_layer(), Some(&layout()));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["fnArg"], 0x01);
        assert_eq!(v["baseArg"], 0x00);
        assert_eq!(v["slotCount"], 126);
        assert_eq!(v["fnKey"]["status"], "fn");
        assert_eq!(v["fnKey"]["baseValue"], 0x0D00_0000u64);
        assert_eq!(v["dead"][0]["name"], "1");
        assert_eq!(v["intact"], false);
        assert!(v["summary"].is_string());
    }
}
