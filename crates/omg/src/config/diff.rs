//! Desired-vs-current comparison (read-only, spec §7).
//!
//! Both inputs are *normalized* documents — `state::read_current` output
//! and `document::Validated::doc` share the same canonical shape (banks
//! in cmd-131 arg order, `0x%08X` key hex, `#rrggbb` colours, sorted
//! macro bindings), so a plain structural walk is sufficient and honest:
//! every reported change is a real leaf difference.

use std::collections::BTreeSet;

use serde_json::{json, Value};

/// Diff `desired.configuration` against `current.configuration`.
/// Returns the `omg.config.diff` envelope body (caller adds `"ok"`).
pub fn diff_documents(current: &Value, desired: &Value) -> Value {
    let mut changes = Vec::new();
    diff_value(
        "configuration",
        current.get("configuration").unwrap_or(&Value::Null),
        desired.get("configuration").unwrap_or(&Value::Null),
        &mut changes,
    );
    // Target binding was already enforced by document::validate; surface
    // it anyway so the diff is self-contained.
    diff_value(
        "target",
        current.get("target").unwrap_or(&Value::Null),
        desired.get("target").unwrap_or(&Value::Null),
        &mut changes,
    );

    let change_count = changes.len();
    let mut sections = serde_json::Map::new();
    for c in &changes {
        if let Some(sec) = c["path"].as_str().and_then(|p| p.split('.').nth(1)) {
            let e = sections.entry(sec.to_string()).or_insert_with(|| json!(0));
            if let Some(n) = e.as_u64() {
                *e = json!(n + 1);
            }
        }
    }
    json!({
        "kind": "omg.config.diff",
        "equal": changes.is_empty(),
        "changes": changes,
        "summary": {
            "changes": change_count,
            "sections": Value::Object(sections),
        },
    })
}

/// Recursive leaf diff. `path` is a dotted/bracketed document path.
fn diff_value(path: &str, cur: &Value, des: &Value, out: &mut Vec<Value>) {
    match (cur, des) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for k in keys {
                diff_value(
                    &format!("{path}.{k}"),
                    a.get(k).unwrap_or(&Value::Null),
                    b.get(k).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for i in 0..a.len().max(b.len()) {
                diff_value(
                    &format!("{path}[{i}]"),
                    a.get(i).unwrap_or(&Value::Null),
                    b.get(i).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        _ => {
            if cur != des {
                out.push(json!({
                    "path": path,
                    "current": cur,
                    "desired": des,
                }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_docs_have_no_changes() {
        let d = json!({"configuration": {"device": {"sleep_timeout_seconds": 30}}, "target": {}});
        let r = diff_documents(&d, &d);
        assert_eq!(r["equal"], true);
        assert_eq!(r["changes"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn leaf_and_array_diffs() {
        let cur = json!({"configuration": {"device": {"sleep_timeout_seconds": 30}, "keymap": {"layers": [{"keys": ["0x00000000", "0x00000001"]}]}}});
        let des = json!({"configuration": {"device": {"sleep_timeout_seconds": 60}, "keymap": {"layers": [{"keys": ["0x00000000", "0x00000002"]}]}}});
        let r = diff_documents(&cur, &des);
        assert_eq!(r["equal"], false);
        let changes = r["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(
            changes[0]["path"],
            "configuration.device.sleep_timeout_seconds"
        );
        assert_eq!(changes[1]["path"], "configuration.keymap.layers[0].keys[1]");
        assert_eq!(r["summary"]["sections"]["device"], 1);
        assert_eq!(r["summary"]["sections"]["keymap"], 1);
    }
}
