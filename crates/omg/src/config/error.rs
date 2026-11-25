//! Stable JSON error envelope for the config surface (spec §8).
//!
//! Every config command reports failures as
//! `{"ok": false, "error": {code, message, path?, retryable, details}}`.
//! Codes are stable strings — agents may branch on them.

use serde_json::{json, Value};

/// Machine-readable failure for the config surface.
#[derive(Debug)]
pub struct ConfigError {
    /// Stable error code (see module docs / `omg guide --json`).
    pub code: &'static str,
    pub message: String,
    /// JSON path inside the config document or command context, if any.
    pub path: Option<String>,
    /// Whether retrying the identical request could succeed.
    pub retryable: bool,
    pub details: Value,
}

impl ConfigError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            path: None,
            retryable: false,
            details: json!({}),
        }
    }

    pub fn at(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }

    /// Part of the stable §8 registry; R1 never sets it (reserved for
    /// transient transport failures in later milestones).
    #[allow(dead_code)]
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    // ── Constructors for the spec §8 code registry ──────────────────────

    /// The document is not valid JSON / not an object / wrong shape.
    pub fn invalid_document(message: impl Into<String>) -> Self {
        Self::new("invalid_document", message)
    }

    /// A property the schema does not declare (additionalProperties:false).
    pub fn unknown_property(path: impl Into<String>, key: &str) -> Self {
        Self::new("unknown_property", format!("unknown property '{key}'"))
            .at(path)
            .with_details(json!({ "property": key }))
    }

    /// A required managed writable field is absent.
    pub fn missing_required_field(path: impl Into<String>, field: &str) -> Self {
        Self::new(
            "missing_required_field",
            format!("missing required field '{field}'"),
        )
        .at(path)
        .with_details(json!({ "field": field }))
    }

    /// format_version / schema_id / target firmware-scheme mismatch.
    pub fn schema_version_unsupported(message: impl Into<String>) -> Self {
        Self::new("schema_version_unsupported", message)
    }

    /// target.device_kind/model/firmware does not match the resolved device.
    pub fn target_mismatch(field: &str, expected: &str, got: &str) -> Self {
        Self::new(
            "target_mismatch",
            format!("target.{field} is '{got}' but the resolved device reports '{expected}'"),
        )
        .at(format!("target.{field}"))
        .with_details(json!({ "field": field, "expected": expected, "got": got }))
    }

    /// The field exists but is not verified/writable for this device.
    /// Part of the stable §8 registry; R1 gates whole families with
    /// `unsupported` instead — kept for per-field gating in R2+.
    #[allow(dead_code)]
    pub fn capability_unverified(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new("capability_unverified", message).at(path)
    }

    /// The device family has no writable configuration surface enabled.
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("unsupported", message)
    }

    /// --device matched zero devices.
    pub fn device_not_found(message: impl Into<String>) -> Self {
        Self::new("device_not_found", message)
    }

    /// --device matched several devices.
    pub fn device_ambiguous(message: impl Into<String>) -> Self {
        Self::new("device_ambiguous", message)
    }

    /// A required device read failed or returned a short/garbled payload.
    /// AGENTS.md §Safety 6: fail closed, never substitute defaults.
    pub fn state_read_failed(what: impl Into<String>, source: impl std::fmt::Display) -> Self {
        Self::new("state_read_failed", format!("{}: {source}", what.into()))
    }

    /// The stable §8 envelope.
    pub fn envelope(&self) -> Value {
        let mut err = json!({
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "details": self.details,
        });
        if let Some(p) = &self.path {
            err["path"] = json!(p);
        }
        json!({ "ok": false, "error": err })
    }

    /// Process exit code per the repo contract (0/1/2/3).
    pub fn exit_code(&self) -> u8 {
        match self.code {
            // No/ambiguous device and read failures are operational, not
            // document errors: 2 = no device, 1 = error.
            "device_not_found" => 2,
            "device_ambiguous" => 2,
            "unsupported" | "capability_unverified" => 3,
            _ => 1,
        }
    }
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ConfigError {}
