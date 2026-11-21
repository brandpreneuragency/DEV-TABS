use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Powershell,
    Python,
    Node,
    Bash,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptInput {
    pub name: String,
    pub description: String,
    pub code: String,
    pub runtime: Runtime,
    pub working_directory: String,
    pub confirmation_required: bool,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    3600
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedScript {
    #[serde(flatten)]
    pub input: ScriptInput,
    pub id: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
impl Status {
    pub fn active(&self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptRun {
    pub id: String,
    pub request_id: String,
    pub script_id: String,
    pub script_name: String,
    pub script_revision: u64,
    pub source_hash: String,
    pub runtime: Runtime,
    pub working_directory: String,
    pub status: Status,
    pub created_at: u64,
    pub started_at: Option<u64>,
    pub completed_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub log_truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: Runtime,
    pub label: String,
    pub executable: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsSnapshot {
    pub scripts: Vec<SavedScript>,
    pub runs: Vec<ScriptRun>,
    pub runtimes: Vec<RuntimeInfo>,
    pub execution_blocked: Option<String>,
    pub default_working_directory: String,
    pub max_concurrent: usize,
    pub max_log_bytes: usize,
    pub max_timeout_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptOutput {
    pub run: ScriptRun,
    pub snapshot: SavedScript,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Catalog {
    pub version: u32,
    pub scripts: Vec<SavedScript>,
    pub runs: Vec<ScriptRun>,
}
