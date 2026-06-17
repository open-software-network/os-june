use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolDestinationClass {
    InternalTdx,
    TrustedUserConnector,
    ExternalUntrusted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardAnalysis {
    pub request_id: String,
    pub canonical_request_hash: String,
    #[serde(default)]
    pub findings: Vec<ToolGuardFinding>,
    #[serde(default)]
    pub advisories: Vec<ToolGuardAdvisory>,
    pub redaction_plan: ToolGuardRedactionPlan,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardFinding {
    pub finding_id: String,
    pub pii_type: String,
    pub confidence_bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default)]
    pub source_roles: Vec<String>,
    pub locator: ToolGuardLocator,
    pub range: ToolGuardTextRange,
    pub replacement: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardAdvisory {
    pub advisory_id: String,
    pub advisory_type: String,
    pub confidence_bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(default)]
    pub source_roles: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardRedactionPlan {
    #[serde(default)]
    pub operations: Vec<ToolGuardRedactionOperation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolGuardRedactionOperation {
    pub finding_id: String,
    pub locator: ToolGuardLocator,
    pub range: ToolGuardTextRange,
    pub replacement: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ToolGuardLocator {
    pub target: ToolGuardLocatorTarget,
    #[serde(default)]
    pub path: Vec<ToolGuardPathSegment>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGuardLocatorTarget {
    Key,
    Value,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolGuardPathSegment {
    ObjectKeySha256 { sha256: String },
    ArrayIndex { index: usize },
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ToolGuardTextRange {
    pub start: usize,
    pub end: usize,
    pub unit: ToolGuardTextRangeUnit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGuardTextRangeUnit {
    UnicodeCodepoint,
}
