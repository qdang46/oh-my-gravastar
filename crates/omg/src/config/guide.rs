//! `omg guide` — the agent workflow/safety guide (spec §15 R1).
//!
//! One JSON document describes the whole read-only surface: how to
//! discover schemas, author and validate documents, read current state,
//! diff, the error-code registry and the safety contract. `omg guide`
//! without `--json` prints a condensed human rendering.

use serde_json::{json, Value};

/// The full guide document (always JSON-shaped).
pub fn doc() -> Value {
    json!({
        "kind": "omg.config.guide",
        "format_version": crate::config::schema::FORMAT_VERSION,
        "workflow": [
            {"step": 1, "cmd": "omg schema", "does": "list config schema families (or `omg schema --device <kind-or-id>` for one JSON Schema 2020-12 doc)"},
            {"step": 2, "cmd": "omg config get --device <sel>", "does": "read the device's current configuration as a valid desired-state document (baseline)"},
            {"step": 3, "cmd": "omg config validate <file> --device <sel>", "does": "strictly validate a desired-state document; `config get` output is always valid input"},
            {"step": 4, "cmd": "omg config diff <file> --device <sel>", "does": "compare desired vs current; `equal:true` means nothing would change"},
            {"step": 5, "cmd": "omg config apply <file> --yes", "does": "NOT IMPLEMENTED in this release — the config surface is read-only"},
        ],
        "document": {
            "envelope": ["format_version", "schema_id", "target{device_kind,model,firmware}", "configuration{...}"],
            "semantics": "full desired state — every managed writable field is required; missing fields are errors, never 'leave unchanged'",
            "keymap": "configuration.keymap.layers: exactly 8 banks (4 layers × 2 systems), each with exactly 126 keys as 0x-prefixed u32 hex",
            "colors": "#rrggbb strings; mode_colors has exactly 23 entries; per_key.colors exactly 126",
            "macros": "configuration.macros: entries with id==position, steps, and bindings that must agree with tag-3 keymap values",
            "opaque": "unknown keymap tags and unrecognized macro step nibbles are preserved byte-identical and reported as warnings — never authored as editable fields",
        },
        "errors": {
            "envelope": "{\"ok\":false,\"error\":{\"code\",\"message\",\"path?\",\"retryable\",\"details\"}}",
            "codes": {
                "invalid_document": "not JSON / wrong shape / bad value",
                "schema_version_unsupported": "format_version or schema_id mismatch",
                "target_mismatch": "document target does not match the resolved device",
                "unknown_property": "property outside the schema (additionalProperties:false)",
                "missing_required_field": "a managed writable field is absent",
                "capability_unverified": "field exists but is not verified/writable for this device",
                "unsupported": "device family has no writable/readable config surface in this release",
                "device_not_found": "--device matched nothing (exit 2)",
                "device_ambiguous": "--device or auto-detect matched several devices (exit 2)",
                "state_read_failed": "a required device read failed or was short — never defaulted (exit 1)",
            },
        },
        "exit_codes": {"0": "ok", "1": "error", "2": "no/ambiguous device", "3": "unsupported"},
        "safety": [
            "read-only: no config command sends a write in this release",
            "every managed field is required — there are no partial updates",
            "opaque/unknown values are preserved verbatim and never defaulted",
            "a failed or short device read aborts with state_read_failed; nothing is guessed",
            "excluded forever from desired state: advanced-key history, screen image, wireless transport, reset, firmware, power telemetry",
        ],
        "families": crate::config::schema::schema_index()["schemas"].clone(),
    })
}

/// Condensed human rendering for `omg guide` without `--json`.
pub fn text() -> String {
    let d = doc();
    let mut s = String::from("omg config guide (read-only release)\n\nworkflow:\n");
    for step in d["workflow"].as_array().unwrap() {
        s.push_str(&format!(
            "  {}. {} — {}\n",
            step["step"], step["cmd"].as_str().unwrap(), step["does"].as_str().unwrap()
        ));
    }
    s.push_str("\ndocument rules:\n");
    s.push_str("  - full desired state: every managed writable field required\n");
    s.push_str("  - envelope: format_version, schema_id, target, configuration\n");
    s.push_str("  - keymap: 8 banks × 126 keys, raw 0x u32 hex; colors #rrggbb\n");
    s.push_str("  - macros: bindings must match tag-3 keymap values\n");
    s.push_str("  - opaque/unknown values preserved verbatim (warnings, never editable)\n");
    s.push_str("\nerror codes: invalid_document schema_version_unsupported target_mismatch\n");
    s.push_str("  unknown_property missing_required_field capability_unverified\n");
    s.push_str("  unsupported device_not_found device_ambiguous state_read_failed\n");
    s.push_str("\nsafety: read-only release — `omg config apply` is not implemented.\n");
    s.push_str("  Failed/short device reads abort (state_read_failed); nothing is guessed.\n");
    s.push_str("  Run `omg guide --json` for the full machine-readable guide.\n");
    s
}
