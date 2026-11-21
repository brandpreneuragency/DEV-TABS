//! Native client for the local OpenCode V2 service.
//!
//! TABS uses the OpenCode desktop service as its chat engine. This module owns
//! discovery, authentication, session ownership and the bounded typed surface
//! that the Tauri commands expose.
//!
//! Ownership is decided here, not by the WebView. A session is *owned* only if
//! it was created by TABS, or if it was verified against the service with all
//! of these facts:
//!
//! * durable metadata `tabsThreadID` is present and non-empty,
//! * `location.directory` is the TABS-owned workspace,
//! * `projectID` matches the project already recorded for that workspace.
//!
//! A changed port, process id or service version triggers rediscovery and
//! reverification; it never drops the ownership map by itself. Ownership is
//! dropped only for an explicit delete or a verified `SessionNotFoundError`.
//!
//! The service password is held in memory only and is never returned, logged or
//! serialized. See [`ServiceSecret`].

mod client;
mod discovery;
pub mod events;
mod startup;
mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use reqwest::{Client, Method};
use serde_json::{json, Value};

use client::ServiceSession;
use discovery::{read_registration, verify_identity};
use types::{
    clamp, error_view, json_text, message_view, model_ref, non_empty_text, session_detail,
};

pub use types::*;

/// Durable session metadata key that marks a TABS thread.
const THREAD_METADATA_KEY: &str = "tabsThreadID";

/// Callback used to publish an event to the WebView. The host itself is
/// framework-agnostic so the transport can be tested without Tauri.
pub type EventSink = Box<dyn Fn(OpenCodeEventKind) + Send + Sync>;

#[derive(Debug, Clone)]
struct OwnedSession {
    thread_id: String,
    project_id: String,
    created: f64,
    generation: u64,
}

#[derive(Debug)]
struct StreamHandle {
    token: Arc<AtomicBool>,
    reader_started: bool,
}

struct State {
    session: Option<ServiceSession>,
    state: ConnectionState,
    generation: u64,
    identity: Option<String>,
    info: Option<ServiceInfo>,
    detail: Option<String>,
    owned: HashMap<String, OwnedSession>,
    expected_project: Option<String>,
    stream: Option<StreamHandle>,
    stream_connected: bool,
}

pub struct Host {
    workspace: PathBuf,
    http: Client,
    sink: EventSink,
    state: Mutex<State>,
    startup: startup::Startup,
    pub(crate) bridge: Mutex<Option<Arc<crate::tab_bridge::Bridge>>>,
}

impl Host {
    /// Stop only TABS-owned listeners and readers. Never stop the shared service.
    pub fn shutdown(&self) {
        self.end_stream();
        crate::tab_bridge::stop(self);
        let mut state = self.lock();
        state.session = None;
    }

    /// Create the host for one TABS-owned workspace directory.
    ///
    /// `workspace` must be an app-local data directory, never a temporary
    /// directory, because it is durable session metadata: mapping and plugin
    /// paths must survive a restart.
    pub fn new(workspace: PathBuf, sink: EventSink) -> OpenCodeResult<Self> {
        if workspace.as_os_str().is_empty() {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "OpenCode workspace directory is required",
            ));
        }
        std::fs::create_dir_all(&workspace).map_err(|_| {
            OpenCodeError::new(
                "internal",
                "OpenCode workspace directory could not be created",
            )
        })?;
        let plugins = workspace.join(".opencode").join("plugins");
        std::fs::create_dir_all(&plugins).map_err(|_| {
            OpenCodeError::new("internal", "TABS plugin directory could not be created")
        })?;
        std::fs::write(
            plugins.join("tabs.js"),
            include_str!("../../../opencode-plugin/index.js"),
        )
        .map_err(|_| OpenCodeError::new("internal", "TABS plugin could not be prepared"))?;
        Ok(Self {
            workspace,
            http: client::client()?,
            sink,
            bridge: Mutex::new(None),
            startup: startup::Startup::default(),
            state: Mutex::new(State {
                session: None,
                state: ConnectionState::Unavailable,
                generation: 0,
                identity: None,
                info: None,
                detail: Some("OpenCode service has not been discovered yet".to_string()),
                owned: HashMap::new(),
                expected_project: None,
                stream: None,
                stream_connected: false,
            }),
        })
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn http(&self) -> &Client {
        &self.http
    }

    fn workspace_string(&self) -> String {
        self.workspace.to_string_lossy().to_string()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    // -----------------------------------------------------------------------
    // Status and lifecycle
    // -----------------------------------------------------------------------

    pub fn status(&self) -> Status {
        let state = self.lock();
        Status {
            state: state.state,
            generation: state.generation,
            version: state.info.as_ref().map(|info| info.version.clone()),
            pid: state.info.as_ref().map(|info| info.pid),
            workspace: self.workspace_string(),
            streaming: state.stream.is_some(),
            detail: state.detail.clone(),
        }
    }

    pub fn current_generation(&self) -> u64 {
        self.lock().generation
    }

    fn emit(&self, event: OpenCodeEventKind) {
        (self.sink)(event);
    }

    fn emit_lifecycle(&self) {
        let status = self.status();
        self.emit(OpenCodeEventKind::Lifecycle {
            state: status.state,
            generation: status.generation,
            streaming: status.streaming,
            detail: status.detail,
        });
    }

    fn set_connection_state(&self, state_kind: ConnectionState, detail: Option<String>) {
        {
            let mut state = self.lock();
            state.state = state_kind;
            state.detail = detail;
            if !state_kind.is_usable() {
                state.session = None;
                state.info = None;
            }
        }
        self.emit_lifecycle();
    }

    // -----------------------------------------------------------------------
    // Discovery
    // -----------------------------------------------------------------------

    /// Read the approved registration file and verify the live service.
    ///
    /// A changed identity bumps [`Status::generation`]; ownership entries are
    /// preserved so a restarted service does not lose the TABS mapping.
    pub async fn discover(&self) -> OpenCodeResult<Status> {
        let result = self
            .startup
            .connect(|| self.discover_registered(), startup::start)
            .await;
        if let Err(error) = &result {
            let state = match error.code {
                "unauthorized" => ConnectionState::Unauthorized,
                "incompatible" => ConnectionState::Incompatible,
                "versionMismatch" => ConnectionState::VersionMismatch,
                _ => ConnectionState::Unavailable,
            };
            self.set_connection_state(state, Some(error.message.clone()));
        }
        result
    }

    async fn discover_registered(&self) -> OpenCodeResult<Status> {
        let registration = match read_registration() {
            Ok(registration) => registration,
            Err(error) => {
                self.set_connection_state(
                    ConnectionState::Unavailable,
                    Some(error.message.clone()),
                );
                return Err(error);
            }
        };
        self.connect_registration(registration).await
    }

    async fn connect_registration(
        &self,
        registration: discovery::Registration,
    ) -> OpenCodeResult<Status> {
        let endpoint = match reqwest::Url::parse(&registration.url) {
            Ok(endpoint) => endpoint,
            Err(_) => {
                let error = OpenCodeError::new(
                    "incompatible",
                    "OpenCode service registration has an invalid endpoint",
                );
                self.set_connection_state(
                    ConnectionState::Incompatible,
                    Some(error.message.clone()),
                );
                return Err(error);
            }
        };
        let session = ServiceSession::new(
            endpoint,
            registration.secret.clone(),
            registration.identity(),
            registration.version.clone(),
        );
        let session = match session {
            Ok(session) => session,
            Err(error) => {
                self.set_connection_state(
                    ConnectionState::Incompatible,
                    Some(error.message.clone()),
                );
                return Err(error);
            }
        };
        let info = match session.info(&self.http).await {
            Ok(info) => info,
            Err(error) => {
                let state_kind = match error.code {
                    "unauthorized" => ConnectionState::Unauthorized,
                    "incompatible" => ConnectionState::Incompatible,
                    _ => ConnectionState::Unavailable,
                };
                self.set_connection_state(state_kind, Some(error.message.clone()));
                return Err(error);
            }
        };
        if let Err(error) = verify_identity(&registration, &info) {
            let state_kind = if error.code == "versionMismatch" {
                ConnectionState::VersionMismatch
            } else {
                ConnectionState::Incompatible
            };
            self.set_connection_state(state_kind, Some(error.message.clone()));
            return Err(error);
        }
        // Project identity comes from resolving our fixed native location, never
        // from the first arbitrary session supplied by the WebView.
        let location = session
            .request(
                &self.http,
                Method::GET,
                "api/location",
                &[("location[directory]", self.workspace_string())],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        let project = location
            .get("project")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                OpenCodeError::new("protocol", "TABS OpenCode project could not be resolved")
            })?
            .to_string();
        if location
            .get("directory")
            .and_then(Value::as_str)
            .map_or(true, |directory| {
                normalize_directory(directory) != normalize_directory(&self.workspace_string())
            })
        {
            return Err(OpenCodeError::not_owned());
        }
        // V2 catalogs are snapshots. The integration endpoint waits for plugin
        // activation, unlike location.get; cold starts must pass this barrier
        // before any caller reads models/agents or connects the TABS plugin.
        session
            .request(
                &self.http,
                Method::GET,
                "api/integration",
                &[("location[directory]", self.workspace_string())],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        {
            let mut state = self.lock();
            let identity = registration.identity();
            if state.identity.as_deref() != Some(identity.as_str()) {
                state.identity = Some(identity);
                state.generation = state.generation.wrapping_add(1);
            }
            state.session = Some(session);
            state.expected_project = Some(project);
            state.info = Some(info);
            state.state = ConnectionState::Connected;
            state.detail = None;
        }
        self.emit_lifecycle();
        Ok(self.status())
    }

    /// Return the verified connection, rediscovering when needed.
    pub async fn ensure_connection(&self) -> OpenCodeResult<ServiceSession> {
        if let Some(session) = self.cached_session() {
            return Ok(session);
        }
        self.discover().await?;
        self.cached_session()
            .ok_or_else(|| OpenCodeError::unavailable("OpenCode service is not connected"))
    }

    fn cached_session(&self) -> Option<ServiceSession> {
        let state = self.lock();
        if !state.state.is_usable() {
            return None;
        }
        state.session.clone()
    }

    /// Drop the cached connection. The next call rediscovers the service.
    pub(crate) fn invalidate_connection(&self, state_kind: ConnectionState) {
        let detail = state_kind.as_str().to_string();
        self.set_connection_state(state_kind, Some(detail));
    }

    fn note_request_error(&self, error: &OpenCodeError) {
        match error.code {
            "unauthorized" | "unavailable" | "not_running" | "transport" => {
                let state_kind = match error.code {
                    "unauthorized" => ConnectionState::Unauthorized,
                    "unavailable" | "not_running" => ConnectionState::Unavailable,
                    _ => ConnectionState::Degraded,
                };
                self.set_connection_state(state_kind, Some(error.message.clone()));
            }
            _ => {}
        }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
        timeout: Duration,
    ) -> OpenCodeResult<Value> {
        let session = self.ensure_connection().await?;
        let result = session
            .request(&self.http, method, path, query, body.as_ref(), timeout)
            .await;
        if let Err(error) = &result {
            self.note_request_error(error);
        }
        result
    }

    // -----------------------------------------------------------------------
    // Event stream lifecycle
    // -----------------------------------------------------------------------

    /// Return true only when a new event reader must be started.
    pub fn begin_stream(&self) -> bool {
        {
            let mut state = self.lock();
            if let Some(handle) = state.stream.as_ref() {
                if !handle.token.load(Ordering::SeqCst) {
                    return false;
                }
            }
            state.stream = Some(StreamHandle {
                token: Arc::new(AtomicBool::new(false)),
                reader_started: false,
            });
        }
        self.emit_lifecycle();
        true
    }

    /// Stop the subscription. The reader observes the token and returns.
    pub fn end_stream(&self) {
        {
            let mut state = self.lock();
            if let Some(handle) = state.stream.take() {
                handle.token.store(true, Ordering::SeqCst);
            }
            state.stream_connected = false;
        }
        self.emit_lifecycle();
    }

    pub fn claim_stream_token(&self) -> Option<Arc<AtomicBool>> {
        let mut state = self.lock();
        let handle = state.stream.as_mut()?;
        if handle.reader_started {
            return None;
        }
        handle.reader_started = true;
        Some(handle.token.clone())
    }

    pub(crate) fn finish_stream(&self, token: &Arc<AtomicBool>) {
        {
            let mut state = self.lock();
            let matches = state
                .stream
                .as_ref()
                .map(|handle| Arc::ptr_eq(&handle.token, token))
                .unwrap_or(false);
            if matches {
                state.stream = None;
                state.stream_connected = false;
            }
        }
        self.emit_lifecycle();
    }

    pub(crate) fn mark_stream_connected(&self) {
        {
            let mut state = self.lock();
            state.stream_connected = true;
            state.state = ConnectionState::Connected;
            state.detail = None;
        }
        self.emit_lifecycle();
    }

    pub(crate) fn mark_stream_degraded(&self, detail: impl Into<String>) {
        {
            let mut state = self.lock();
            state.stream_connected = false;
            if state.session.is_some() {
                state.state = ConnectionState::Degraded;
            }
            state.detail = Some(detail.into());
        }
        self.emit_lifecycle();
    }

    /// Publish one stream record after filtering it by session ownership.
    ///
    /// Foreign sessions are dropped before any content is serialized, so no raw
    /// foreign event can cross the IPC boundary.
    pub(crate) fn handle_stream_record(&self, record: Value) {
        let Some(event) = stream_event(&record) else {
            return;
        };
        if !self.is_owned(&event.session_id) {
            return;
        }
        if event.kind == "session.execution.interrupted" || event.kind == "session.execution.failed"
        {
            crate::tab_bridge::cancel_session(self, &event.session_id);
        }
        self.emit(OpenCodeEventKind::Stream { event });
    }

    pub fn is_owned(&self, session_id: &str) -> bool {
        let state = self.lock();
        state
            .owned
            .get(session_id)
            .is_some_and(|owned| owned.generation == state.generation)
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------

    fn own(&self, detail: &SessionDetail) -> bool {
        let thread_id = match detail.thread_id.as_deref() {
            Some(thread_id) => thread_id.to_string(),
            None => return false,
        };
        let mut state = self.lock();
        let generation = state.generation;
        if state.expected_project.is_none() {
            state.expected_project = Some(detail.project_id.clone());
        }
        state
            .owned
            .entry(detail.id.clone())
            .and_modify(|entry| {
                entry.thread_id = thread_id.clone();
                entry.project_id = detail.project_id.clone();
                entry.generation = generation;
            })
            .or_insert(OwnedSession {
                thread_id,
                project_id: detail.project_id.clone(),
                created: detail.created,
                generation,
            });
        true
    }

    fn expected_project(&self) -> Option<String> {
        self.lock().expected_project.clone()
    }

    async fn require_owned(&self, session_id: &str) -> OpenCodeResult<()> {
        // Even a previously owned session can be moved or have its marker changed
        // by another client. Verify the live target before every session operation.
        let previous = self
            .lock()
            .owned
            .get(session_id)
            .cloned()
            .ok_or_else(OpenCodeError::not_owned)?;
        let result = async {
            let raw = self.fetch_session(session_id).await?;
            let detail = verify_ownership(&self.workspace, Some(&previous.project_id), &raw)?;
            if detail.thread_id.as_deref() != Some(previous.thread_id.as_str())
                || detail.created != previous.created
            {
                return Err(OpenCodeError::not_owned());
            }
            self.own(&detail);
            Ok(())
        }
        .await;
        if result.is_err() {
            self.suspend_ownership(session_id);
        }
        result
    }

    fn suspend_ownership(&self, session_id: &str) {
        let mut state = self.lock();
        let invalid = state.generation.wrapping_sub(1);
        if let Some(owned) = state.owned.get_mut(session_id) {
            owned.generation = invalid;
        }
    }

    pub(crate) async fn reverify_owned(&self, token: &AtomicBool) {
        let sessions: Vec<_> = self.lock().owned.keys().cloned().collect();
        for session_id in sessions {
            if token.load(Ordering::SeqCst) {
                break;
            }
            let _ = self.require_owned(&session_id).await;
        }
    }

    pub fn thread_id_for(&self, session_id: &str) -> Option<String> {
        self.lock()
            .owned
            .get(session_id)
            .map(|entry| entry.thread_id.clone())
    }

    /// Verify every given session against the service and adopt the matches.
    ///
    /// The WebView can only name sessions here. Ownership is granted by the
    /// durable server facts, never by the caller.
    pub async fn rebind_sessions(&self, session_ids: Vec<String>) -> Vec<RebindOutcome> {
        if let Err(error) = self.ensure_connection().await {
            return session_ids
                .into_iter()
                .take(MAX_REBIND)
                .map(|session_id| RebindOutcome {
                    session_id,
                    owned: false,
                    reason: Some(error.code.to_string()),
                    session: None,
                })
                .collect();
        }
        let expected_project = self.expected_project();
        let mut outcomes = Vec::new();
        for session_id in session_ids.into_iter().take(MAX_REBIND) {
            let session_id = session_id.trim().to_string();
            if session_id.is_empty() {
                continue;
            }
            let outcome = match self.fetch_session(&session_id).await {
                Ok(raw) => {
                    let previous = self.lock().owned.get(&session_id).cloned();
                    let verified =
                        verify_ownership(&self.workspace, expected_project.as_deref(), &raw)
                            .and_then(|detail| {
                                if previous.as_ref().is_some_and(|old| {
                                    detail.thread_id.as_deref() != Some(old.thread_id.as_str())
                                        || detail.created != old.created
                                }) {
                                    Err(OpenCodeError::not_owned())
                                } else {
                                    Ok(detail)
                                }
                            });
                    match verified {
                        Ok(detail) => {
                            self.own(&detail);
                            RebindOutcome {
                                session_id,
                                owned: true,
                                reason: None,
                                session: Some(detail),
                            }
                        }
                        Err(error) => {
                            self.suspend_ownership(&session_id);
                            RebindOutcome {
                                session_id,
                                owned: false,
                                reason: Some(error.code.to_string()),
                                session: None,
                            }
                        }
                    }
                }
                Err(error) => {
                    self.suspend_ownership(&session_id);
                    RebindOutcome {
                        session_id,
                        owned: false,
                        reason: Some(error.code.to_string()),
                        session: None,
                    }
                }
            };
            outcomes.push(outcome);
        }
        outcomes
    }

    async fn fetch_session(&self, session_id: &str) -> OpenCodeResult<Value> {
        let path = format!("api/session/{}", encode_segment(session_id));
        let value = self
            .call(Method::GET, &path, &[], None, client::REQUEST_TIMEOUT)
            .await?;
        value
            .get("data")
            .cloned()
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode session response is malformed"))
    }

    // -----------------------------------------------------------------------
    // Catalogs
    // -----------------------------------------------------------------------

    pub async fn list_models(&self) -> OpenCodeResult<Vec<ModelSummary>> {
        let value = self
            .call(
                Method::GET,
                "api/model",
                &[("location[directory]", self.workspace_string())],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        let items = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode model list is malformed"))?;
        let mut models: Vec<ModelSummary> = items
            .iter()
            .filter_map(model_summary)
            .take(MAX_MODELS)
            .collect();
        models.sort_by(|left, right| {
            left.provider_id
                .cmp(&right.provider_id)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(models)
    }

    pub async fn list_agents(&self) -> OpenCodeResult<Vec<AgentSummary>> {
        let value = self
            .call(
                Method::GET,
                "api/agent",
                &[("location[directory]", self.workspace_string())],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        let items = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode agent list is malformed"))?;
        Ok(items.iter().filter_map(agent_summary).collect())
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    /// Create a session in the TABS-owned workspace.
    ///
    /// `thread_id` is the durable TABS thread identifier and is stored in
    /// session metadata so ownership survives a restart.
    pub async fn create_session(
        &self,
        thread_id: &str,
        title: Option<&str>,
        model: Option<&ModelRefView>,
        agent: Option<&str>,
    ) -> OpenCodeResult<SessionDetail> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "A TABS thread identifier is required to create an OpenCode session",
            ));
        }
        std::fs::create_dir_all(&self.workspace).map_err(|_| {
            OpenCodeError::new(
                "internal",
                "OpenCode workspace directory could not be created",
            )
        })?;
        let mut body = json!({
            "location": { "directory": self.workspace_string() },
            "metadata": { THREAD_METADATA_KEY: thread_id },
            "permissions": [
                { "action": "tabs.mutate", "resource": "*", "effect": "ask" }
            ],
        });
        if let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) {
            body["title"] = json!(title);
        }
        if let Some(model) = model {
            body["model"] = json!({
                "id": model.id,
                "providerID": model.provider_id,
            });
        }
        if let Some(agent) = agent.map(str::trim).filter(|agent| !agent.is_empty()) {
            body["agent"] = json!(agent);
        }
        let value = self
            .call(
                Method::POST,
                "api/session",
                &[],
                Some(body),
                client::REQUEST_TIMEOUT,
            )
            .await?;
        let raw = value.get("data").ok_or_else(|| {
            OpenCodeError::new("protocol", "OpenCode session response is malformed")
        })?;
        let detail = verify_ownership(&self.workspace, self.expected_project().as_deref(), raw)?;
        self.own(&detail);
        Ok(detail)
    }

    /// Read one owned session and refresh its recorded metadata.
    pub async fn get_session(&self, session_id: &str) -> OpenCodeResult<SessionDetail> {
        self.require_owned(session_id).await?;
        let raw = self.fetch_session(session_id).await?;
        let detail = verify_ownership(&self.workspace, self.expected_project().as_deref(), &raw)?;
        self.own(&detail);
        Ok(detail)
    }

    /// Authoritative transcript read.
    ///
    /// `GET /api/session/{id}/context` returns the full ordered transcript and
    /// is preferred over `/message`, which can lag a completed turn.
    pub async fn get_messages(&self, session_id: &str) -> OpenCodeResult<Vec<MessageView>> {
        self.require_owned(session_id).await?;
        let path = format!("api/session/{}/context", encode_segment(session_id));
        let value = self
            .call(Method::GET, &path, &[], None, client::CONTEXT_TIMEOUT)
            .await?;
        let items = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode transcript is malformed"))?;
        Ok(items
            .iter()
            .skip(items.len().saturating_sub(MAX_MESSAGES))
            .filter_map(|item| message_view(session_id, item))
            .take(MAX_MESSAGES)
            .collect())
    }

    pub(crate) async fn plugin_rpc(&self, method: &str, input: Value) -> OpenCodeResult<Value> {
        self.call(
            Method::POST,
            &format!("api/rpc/tabs.bridge/{method}"),
            &[("location[directory]", self.workspace_string())],
            Some(json!({"input": input})),
            client::REQUEST_TIMEOUT,
        )
        .await
    }

    /// Validate the executor's real running call against the authoritative
    /// transcript. A WebView cannot invent a call, admission or another session.
    pub(crate) async fn validate_tool_call(
        &self,
        session_id: &str,
        admission_id: &str,
        message_id: &str,
        call_id: &str,
        tool_name: &str,
        input: &Value,
    ) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        let path = format!("api/session/{}/context", encode_segment(session_id));
        let response = self
            .call(Method::GET, &path, &[], None, client::CONTEXT_TIMEOUT)
            .await?;
        let items = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode transcript is malformed"))?;
        verify_tool_call(items, admission_id, message_id, call_id, tool_name, input)
    }

    /// Admit one user turn.
    ///
    /// `admission_id` is the client-supplied idempotent admission id (pattern
    /// `^msg_`). A replay returns the same id, so a retry cannot duplicate the
    /// turn. It is not an ordering key.
    pub async fn prompt(
        &self,
        session_id: &str,
        admission_id: &str,
        text: &str,
    ) -> OpenCodeResult<InboxAdmission> {
        self.require_owned(session_id).await?;
        if !admission_id.starts_with("msg_")
            || admission_id.len() > 160
            || text.len() > MAX_TEXT_CHARS
        {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "An admission id is required to submit a turn",
            ));
        }
        let body = json!({
            "id": admission_id,
            "text": text,
            "delivery": "steer",
        });
        let path = format!("api/session/{}/prompt", encode_segment(session_id));
        let value = self
            .call(Method::POST, &path, &[], Some(body), client::PROMPT_TIMEOUT)
            .await?;
        let raw = value.get("data").ok_or_else(|| {
            OpenCodeError::new("protocol", "OpenCode admission response is malformed")
        })?;
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(admission_id)
            .to_string();
        Ok(InboxAdmission {
            id,
            session_id: raw
                .get("sessionID")
                .and_then(Value::as_str)
                .unwrap_or(session_id)
                .to_string(),
            created: raw
                .get("time")
                .and_then(|time| time.get("created"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            delivery: raw
                .get("delivery")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// Interrupt the active turn. Returns whether an execution was interrupted.
    pub async fn interrupt(&self, session_id: &str) -> OpenCodeResult<bool> {
        self.require_owned(session_id).await?;
        crate::tab_bridge::cancel_session(self, session_id);
        let path = format!("api/session/{}/interrupt", encode_segment(session_id));
        let value = self
            .call(
                Method::POST,
                &path,
                &[("resume", "false".to_string())],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        Ok(value
            .get("interrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    pub async fn switch_model(&self, session_id: &str, model: &ModelRefView) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        let mut reference = json!({
            "id": model.id,
            "providerID": model.provider_id,
        });
        if let Some(variant) = model.variant.as_deref() {
            reference["variant"] = json!(variant);
        }
        let path = format!("api/session/{}/model", encode_segment(session_id));
        self.call(
            Method::POST,
            &path,
            &[],
            Some(json!({ "model": reference })),
            client::REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    pub async fn switch_agent(&self, session_id: &str, agent: &str) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        let agent = agent.trim();
        if agent.is_empty() {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "An agent identifier is required",
            ));
        }
        let path = format!("api/session/{}/agent", encode_segment(session_id));
        self.call(
            Method::POST,
            &path,
            &[],
            Some(json!({ "agent": agent })),
            client::REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    pub async fn delete_session(&self, session_id: &str) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        // OpenCode recursively removes descendants. Do not turn selection of
        // one TABS session into implicit authority to remove other sessions.
        let children = self
            .call(
                Method::GET,
                "api/session",
                &[
                    ("parentID", session_id.to_string()),
                    ("limit", "1".to_string()),
                ],
                None,
                client::REQUEST_TIMEOUT,
            )
            .await?;
        if children
            .get("data")
            .and_then(Value::as_array)
            .map_or(true, |items| !items.is_empty())
        {
            return Err(OpenCodeError::new(
                "conflict",
                "Remove child sessions explicitly before deleting this session",
            ));
        }
        let path = format!("api/session/{}", encode_segment(session_id));
        self.call(Method::DELETE, &path, &[], None, client::REQUEST_TIMEOUT)
            .await?;
        self.lock().owned.remove(session_id);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Forms and permissions
    // -----------------------------------------------------------------------

    pub async fn list_forms(&self, session_id: &str) -> OpenCodeResult<Vec<FormSummary>> {
        self.require_owned(session_id).await?;
        let path = format!("api/session/{}/form", encode_segment(session_id));
        let value = self
            .call(Method::GET, &path, &[], None, client::REQUEST_TIMEOUT)
            .await?;
        let items = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode form list is malformed"))?;
        Ok(items.iter().filter_map(form_summary).collect())
    }

    pub async fn reply_form(
        &self,
        session_id: &str,
        form_id: &str,
        answer: Value,
    ) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        if !answer.is_object() {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "A form answer must map field keys to values",
            ));
        }
        let path = format!(
            "api/session/{}/form/{}/reply",
            encode_segment(session_id),
            encode_segment(form_id)
        );
        self.call(
            Method::POST,
            &path,
            &[],
            Some(json!({ "answer": answer })),
            client::REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    pub async fn list_permissions(
        &self,
        session_id: &str,
    ) -> OpenCodeResult<Vec<PermissionSummary>> {
        self.require_owned(session_id).await?;
        let path = format!("api/session/{}/permission", encode_segment(session_id));
        let value = self
            .call(Method::GET, &path, &[], None, client::REQUEST_TIMEOUT)
            .await?;
        let items = value.get("data").and_then(Value::as_array).ok_or_else(|| {
            OpenCodeError::new("protocol", "OpenCode permission list is malformed")
        })?;
        Ok(items.iter().filter_map(permission_summary).collect())
    }

    pub async fn reply_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: &str,
        message: Option<&str>,
    ) -> OpenCodeResult<()> {
        self.require_owned(session_id).await?;
        let decision = decision.trim();
        if !matches!(decision, "once" | "always" | "reject") {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "Permission decision must be once, always or reject",
            ));
        }
        let mut body = json!({ "decision": decision });
        if let Some(message) = message.map(str::trim).filter(|message| !message.is_empty()) {
            body["message"] = json!(message);
        }
        let path = format!(
            "api/session/{}/permission/{}/reply",
            encode_segment(session_id),
            encode_segment(request_id)
        );
        self.call(
            Method::POST,
            &path,
            &[],
            Some(body),
            client::REQUEST_TIMEOUT,
        )
        .await?;
        Ok(())
    }
}

fn verify_tool_call(
    items: &[Value],
    admission_id: &str,
    message_id: &str,
    call_id: &str,
    tool_name: &str,
    input: &Value,
) -> OpenCodeResult<()> {
    let index = items
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(message_id))
        .ok_or_else(OpenCodeError::not_owned)?;
    let user = items[..index]
        .iter()
        .rev()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("user"));
    if items[index].get("type").and_then(Value::as_str) != Some("assistant")
        || user.and_then(|item| item.get("id")).and_then(Value::as_str) != Some(admission_id)
    {
        return Err(OpenCodeError::not_owned());
    }
    let valid = items[index]
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts.iter().any(|part| {
                part.get("type").and_then(Value::as_str) == Some("tool")
                    && part.get("id").and_then(Value::as_str) == Some(call_id)
                    && part.get("name").and_then(Value::as_str) == Some(tool_name)
                    && part.pointer("/state/status").and_then(Value::as_str) == Some("running")
                    && part.pointer("/state/input") == Some(input)
            })
        });
    if valid {
        Ok(())
    } else {
        Err(OpenCodeError::not_owned())
    }
}

/// Percent-encode one path segment. Session and form identifiers are opaque.
fn encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Normalize a directory path for comparison on this platform.
fn normalize_directory(path: &str) -> String {
    let mut text = path.trim().replace('/', "\\");
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

/// Verify that a raw session payload is a TABS-owned session.
pub(crate) fn verify_ownership(
    workspace: &Path,
    expected_project: Option<&str>,
    raw: &Value,
) -> OpenCodeResult<SessionDetail> {
    let detail = session_detail(raw)
        .ok_or_else(|| OpenCodeError::new("protocol", "OpenCode session payload is malformed"))?;
    if detail.thread_id.is_none() {
        return Err(OpenCodeError::not_owned());
    }
    let expected = normalize_directory(&workspace.to_string_lossy());
    if normalize_directory(&detail.directory) != expected {
        return Err(OpenCodeError::not_owned());
    }
    if let Some(project) = expected_project {
        if !project.is_empty() && project != detail.project_id {
            return Err(OpenCodeError::not_owned());
        }
    }
    Ok(detail)
}

// ---------------------------------------------------------------------------
// Bounded mapping from service payloads
// ---------------------------------------------------------------------------

fn model_summary(value: &Value) -> Option<ModelSummary> {
    let id = non_empty_text(value.get("id")?)?;
    let provider_id = non_empty_text(value.get("providerID")?)?;
    Some(ModelSummary {
        id,
        provider_id,
        model_id: non_empty_text(value.get("modelID").unwrap_or(&Value::Null)).unwrap_or_default(),
        name: non_empty_text(value.get("name").unwrap_or(&Value::Null)).unwrap_or_default(),
        family: non_empty_text(value.get("family").unwrap_or(&Value::Null)),
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        tools: value
            .get("capabilities")
            .and_then(|capabilities| capabilities.get("tools"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_limit: value
            .get("limit")
            .and_then(|limit| limit.get("context"))
            .and_then(Value::as_i64),
        output_limit: value
            .get("limit")
            .and_then(|limit| limit.get("output"))
            .and_then(Value::as_i64),
    })
}

fn agent_summary(value: &Value) -> Option<AgentSummary> {
    let id = non_empty_text(value.get("id")?)?;
    Some(AgentSummary {
        name: non_empty_text(value.get("name").unwrap_or(&Value::Null))
            .unwrap_or_else(|| id.clone()),
        id,
        mode: non_empty_text(value.get("mode").unwrap_or(&Value::Null))
            .unwrap_or_else(|| "primary".to_string()),
        description: non_empty_text(value.get("description").unwrap_or(&Value::Null)),
        hidden: value
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        model: value.get("model").and_then(model_ref),
    })
}

fn form_summary(value: &Value) -> Option<FormSummary> {
    let id = non_empty_text(value.get("id")?)?;
    let session_id = non_empty_text(value.get("sessionID")?)?;
    let fields = value
        .get("fields")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(form_field).collect())
        .unwrap_or_default();
    Some(FormSummary {
        id,
        session_id,
        title: non_empty_text(value.get("title").unwrap_or(&Value::Null))
            .unwrap_or_else(|| "OpenCode form".to_string()),
        fields,
    })
}

fn form_field(value: &Value) -> Option<FormFieldView> {
    let key = non_empty_text(value.get("key")?)?;
    let kind = non_empty_text(value.get("type").unwrap_or(&Value::Null))
        .unwrap_or_else(|| "string".to_string());
    let options = value
        .get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|option| {
                    Some(FormOptionView {
                        value: non_empty_text(option.get("value")?)?,
                        label: non_empty_text(option.get("label").unwrap_or(&Value::Null))
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(FormFieldView {
        key: key.clone(),
        kind,
        title: non_empty_text(value.get("title").unwrap_or(&Value::Null)),
        description: non_empty_text(value.get("description").unwrap_or(&Value::Null)),
        required: value
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        hidden: value
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        options,
        url: non_empty_text(value.get("url").unwrap_or(&Value::Null)),
        schema: if value.to_string().len() <= 16 * 1024 {
            value.clone()
        } else {
            json!({ "key": key, "type": "unsupported" })
        },
    })
}

fn permission_summary(value: &Value) -> Option<PermissionSummary> {
    Some(PermissionSummary {
        id: non_empty_text(value.get("id")?)?,
        session_id: non_empty_text(value.get("sessionID")?)?,
        action: non_empty_text(value.get("action").unwrap_or(&Value::Null)).unwrap_or_default(),
        resources: value
            .get("resources")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .take(MAX_PARTS)
                    .collect()
            })
            .unwrap_or_default(),
        message: non_empty_text(value.get("message").unwrap_or(&Value::Null))
            .or_else(|| value.pointer("/metadata/summary").and_then(non_empty_text)),
    })
}

/// Map one service event to a bounded view. Returns `None` when the record is
/// not a session event we surface.
fn stream_event(value: &Value) -> Option<StreamEvent> {
    let kind = non_empty_text(value.get("type")?)?;
    let data = value.get("data")?;
    let session_id = non_empty_text(data.get("sessionID")?)?;
    let mut event = StreamEvent {
        session_id,
        kind: kind.clone(),
        created: value.get("created").and_then(Value::as_f64).unwrap_or(0.0),
        assistant_message_id: non_empty_text(
            data.get("assistantMessageID").unwrap_or(&Value::Null),
        ),
        part_id: None,
        seq: value
            .get("durable")
            .and_then(|durable| durable.get("seq"))
            .and_then(Value::as_i64),
        delta: None,
        tool: None,
        error: None,
        status: None,
    };
    match kind.as_str() {
        "session.text.delta" | "session.reasoning.delta" => {
            event.delta = data
                .get("delta")
                .and_then(Value::as_str)
                .map(|delta| clamp(delta, MAX_INPUT_CHARS));
        }
        "session.tool.input.delta" => {
            event.part_id = non_empty_text(data.get("id").unwrap_or(&Value::Null));
            event.delta = data
                .get("delta")
                .and_then(Value::as_str)
                .map(|delta| clamp(delta, MAX_INPUT_CHARS));
        }
        "session.tool.called" => {
            event.part_id = non_empty_text(data.get("id").unwrap_or(&Value::Null));
            event.tool = Some(ToolPart {
                id: event.part_id.clone().unwrap_or_default(),
                // The live call event carries no tool name; the authoritative
                // transcript read supplies the label.
                name: "tool".to_string(),
                status: "running".to_string(),
                input: data.get("input").and_then(json_text),
                output: None,
                error: None,
            });
        }
        "session.tool.progress" => {
            event.part_id = non_empty_text(data.get("id").unwrap_or(&Value::Null));
            event.tool = Some(ToolPart {
                id: event.part_id.clone().unwrap_or_default(),
                name: "tool".to_string(),
                status: "running".to_string(),
                input: None,
                output: None,
                error: None,
            });
        }
        "session.tool.success" => {
            event.part_id = non_empty_text(data.get("id").unwrap_or(&Value::Null));
            event.tool = Some(ToolPart {
                id: event.part_id.clone().unwrap_or_default(),
                name: "tool".to_string(),
                status: "completed".to_string(),
                input: None,
                output: None,
                error: None,
            });
        }
        "session.tool.failed" => {
            event.part_id = non_empty_text(data.get("id").unwrap_or(&Value::Null));
            event.error = data.get("error").and_then(error_view);
            event.tool = Some(ToolPart {
                id: event.part_id.clone().unwrap_or_default(),
                name: "tool".to_string(),
                status: "error".to_string(),
                input: None,
                output: None,
                error: event.error.clone(),
            });
        }
        "session.status" => {
            event.status = non_empty_text(
                data.get("status")
                    .and_then(|status| status.get("type"))
                    .unwrap_or(&Value::Null),
            );
        }
        "session.execution.interrupted" => {
            event.status = non_empty_text(data.get("reason").unwrap_or(&Value::Null));
        }
        "session.execution.failed" => {
            event.error = data.get("error").and_then(error_view);
        }
        "session.retry.scheduled" => {
            event.error = Some(MessageError {
                kind: "retry".to_string(),
                message: data
                    .get("error")
                    .and_then(error_view)
                    .map(|error| error.message)
                    .unwrap_or_else(|| "The provider scheduled a retry".to_string()),
            });
        }
        _ => {}
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    #[ignore = "Explicit owned synthetic shared-service acceptance; no model execution"]
    fn live_shared_service_plugin_and_sse() {
        let root = PathBuf::from("C:/Users/burak/AppData/Local/Temp/opencode")
            .join(format!("tabs-native-live-{}", std::process::id()));
        let (send, receive) = std::sync::mpsc::channel();
        let host = Arc::new(
            Host::new(
                root,
                Box::new(move |event| {
                    let _ = send.send(event);
                }),
            )
            .expect("host"),
        );
        tauri::async_runtime::block_on(host.discover()).expect("discover approved service");
        let detail = tauri::async_runtime::block_on(host.create_session(
            "synthetic-native-check",
            Some("TABS synthetic native check"),
            None,
            None,
        ))
        .expect("create");
        assert_eq!(detail.thread_id.as_deref(), Some("synthetic-native-check"));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut connected = false;
            for _ in 0..15 {
                if tauri::async_runtime::block_on(crate::tab_bridge::start(
                    host.clone(),
                    Arc::new(|_| {}),
                ))
                .is_ok()
                {
                    connected = true;
                    break;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            assert!(
                connected,
                "scoped plugin RPC failed to activate on shared service"
            );
            tauri::async_runtime::block_on(crate::tab_bridge::bind(
                host.clone(),
                detail.id.clone(),
                "msg_tabs_native_synthetic".to_string(),
                vec![crate::tab_bridge::ToolSpec { name: "tabs_document_read_v1".to_string(), description: "Synthetic fixture read".to_string(),
                    input_schema: json!({"type":"object", "properties":{}, "additionalProperties":false}), read_only: true }],
            ))
            .expect("plugin binding");
            host.begin_stream();
            let runner = host.clone();
            tauri::async_runtime::spawn(async move {
                events::run(
                    runner,
                    Arc::new(|ms| {
                        Box::pin(async move {
                            let _ = tauri::async_runtime::spawn_blocking(move || {
                                std::thread::sleep(Duration::from_millis(ms))
                            })
                            .await;
                        })
                    }),
                )
                .await;
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while std::time::Instant::now() < deadline {
                let _ = receive.recv_timeout(Duration::from_millis(100));
                if host.lock().stream_connected {
                    break;
                }
            }
            assert!(host.lock().stream_connected, "SSE connection unavailable");
            // Admission without resume is a synthetic no-model turn.
            let path = format!("api/session/{}/prompt", detail.id);
            tauri::async_runtime::block_on(host.call(Method::POST, &path, &[],
                Some(json!({"id":"msg_tabs_native_synthetic", "text":"Synthetic no-model acceptance", "resume":false})), client::PROMPT_TIMEOUT)).expect("synthetic admission");
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            let mut observed = false;
            while std::time::Instant::now() < deadline {
                if let Ok(OpenCodeEventKind::Stream { event }) =
                    receive.recv_timeout(Duration::from_millis(200))
                {
                    assert_eq!(
                        event.session_id, detail.id,
                        "foreign event crossed native boundary"
                    );
                    observed = true;
                    break;
                }
            }
            assert!(observed, "owned SSE event was not received");
            // resume=false remains in the durable inbox, not /context. Verify
            // replay identity without starting a paid/default model execution.
            let replay = tauri::async_runtime::block_on(host.call(Method::POST, &path, &[],
                Some(json!({"id":"msg_tabs_native_synthetic", "text":"Synthetic no-model acceptance", "resume":false})), client::PROMPT_TIMEOUT)).expect("admission replay");
            assert_eq!(
                replay.pointer("/data/id").and_then(Value::as_str),
                Some("msg_tabs_native_synthetic")
            );
            tauri::async_runtime::block_on(host.get_messages(&detail.id)).expect("context read");
            tauri::async_runtime::block_on(host.interrupt(&detail.id)).expect("interrupt");
            tauri::async_runtime::block_on(host.discover()).expect("rediscover");
            let rebound =
                tauri::async_runtime::block_on(host.rebind_sessions(vec![detail.id.clone()]));
            assert!(rebound[0].owned);
        }));
        host.end_stream();
        crate::tab_bridge::stop(&host);
        tauri::async_runtime::block_on(host.delete_session(&detail.id))
            .expect("delete only synthetic session");
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    fn workspace() -> PathBuf {
        PathBuf::from("C:\\Users\\burak\\AppData\\Local\\TABS\\opencode-workspace")
    }

    #[test]
    fn tool_call_requires_exact_running_call_and_preceding_bound_user() {
        let items = vec![
            json!({"id":"msg_user", "type":"user"}),
            json!({"id":"msg_assistant", "type":"assistant",
            "content":[{"type":"tool", "id":"call", "name":"tabs_tasks_create_v1", "state":{"status":"running", "input":{"title":"fixture"}}}]} ),
        ];
        assert!(verify_tool_call(
            &items,
            "msg_user",
            "msg_assistant",
            "call",
            "tabs_tasks_create_v1",
            &json!({"title":"fixture"})
        )
        .is_ok());
        assert!(verify_tool_call(
            &items,
            "msg_foreign",
            "msg_assistant",
            "call",
            "tabs_tasks_create_v1",
            &json!({"title":"fixture"})
        )
        .is_err());
        assert!(verify_tool_call(
            &items,
            "msg_user",
            "msg_assistant",
            "forged",
            "tabs_tasks_create_v1",
            &json!({"title":"fixture"})
        )
        .is_err());
        assert!(verify_tool_call(
            &items,
            "msg_user",
            "msg_assistant",
            "call",
            "tabs_tasks_create_v1",
            &json!({"title":"changed"})
        )
        .is_err());
        let mut settled = items.clone();
        settled[1]["content"][0]["state"]["status"] = json!("completed");
        assert!(verify_tool_call(
            &settled,
            "msg_user",
            "msg_assistant",
            "call",
            "tabs_tasks_create_v1",
            &json!({"title":"fixture"})
        )
        .is_err());
    }

    #[test]
    fn stream_lifecycle_is_idempotent_and_old_reader_cannot_close_new_stream() {
        let temp = tempfile::tempdir().expect("fixture");
        let host = Host::new(temp.path().to_path_buf(), Box::new(|_| {})).expect("host");
        assert!(host.begin_stream());
        assert!(!host.begin_stream());
        let old = host.claim_stream_token().expect("reader");
        assert!(host.claim_stream_token().is_none());
        host.end_stream();
        assert!(old.load(Ordering::SeqCst));
        assert!(host.begin_stream());
        host.finish_stream(&old);
        assert!(host.status().streaming);
        assert!(host.claim_stream_token().is_some());
    }

    #[test]
    fn foreign_events_are_removed_before_ipc_and_identity_changes_suspend_owned_events() {
        let temp = tempfile::tempdir().expect("fixture");
        let (send, receive) = std::sync::mpsc::channel();
        let host = Host::new(
            temp.path().to_path_buf(),
            Box::new(move |event| {
                let _ = send.send(event);
            }),
        )
        .expect("host");
        host.lock().owned.insert(
            "ses_owned".into(),
            OwnedSession {
                thread_id: "thread".into(),
                project_id: "p".into(),
                created: 1.0,
                generation: 0,
            },
        );
        host.handle_stream_record(json!({"type":"session.text.delta", "data":{"sessionID":"ses_foreign", "delta":"private"}}));
        assert!(receive.try_recv().is_err());
        host.handle_stream_record(json!({"type":"session.text.delta", "data":{"sessionID":"ses_owned", "delta":"fixture"}}));
        assert!(receive.try_recv().is_ok());
        host.lock().generation = 1;
        host.handle_stream_record(json!({"type":"session.text.delta", "data":{"sessionID":"ses_owned", "delta":"not verified yet"}}));
        assert!(receive.try_recv().is_err());
        assert!(
            host.thread_id_for("ses_owned").is_some(),
            "mapping must survive identity change"
        );
    }

    fn session_payload(directory: &str, project: &str, marker: Value) -> Value {
        json!({
            "id": "ses_1",
            "projectID": project,
            "title": "Thread",
            "time": { "created": 10.0, "updated": 11.0 },
            "location": { "directory": directory },
            "metadata": { "tabsThreadID": marker }
        })
    }

    #[test]
    fn owned_session_requires_marker_location_and_project() {
        let good = session_payload(
            "C:/Users/burak/AppData/Local/TABS/opencode-workspace/",
            "proj",
            json!("thread-1"),
        );
        let detail = verify_ownership(&workspace(), Some("proj"), &good).expect("owned");
        assert_eq!(detail.thread_id.as_deref(), Some("thread-1"));

        let no_marker = session_payload(
            "C:/Users/burak/AppData/Local/TABS/opencode-workspace",
            "proj",
            Value::Null,
        );
        assert_eq!(
            verify_ownership(&workspace(), Some("proj"), &no_marker)
                .unwrap_err()
                .code,
            "not_owned"
        );

        let foreign_location = session_payload("C:/Users/burak", "proj", json!("thread-1"));
        assert_eq!(
            verify_ownership(&workspace(), Some("proj"), &foreign_location)
                .unwrap_err()
                .code,
            "not_owned"
        );

        let foreign_project = session_payload(
            "C:/Users/burak/AppData/Local/TABS/opencode-workspace",
            "other",
            json!("thread-1"),
        );
        assert_eq!(
            verify_ownership(&workspace(), Some("proj"), &foreign_project)
                .unwrap_err()
                .code,
            "not_owned"
        );
    }

    #[test]
    fn directory_comparison_ignores_case_and_separators_on_windows() {
        let lower = normalize_directory("c:/users/burak/appdata/local/tabs/opencode-workspace");
        let upper =
            normalize_directory("C:\\Users\\burak\\AppData\\Local\\TABS\\opencode-workspace");
        assert_eq!(lower, upper);
    }

    #[test]
    fn stream_records_are_bounded_and_mapped() {
        let value = json!({
            "id": "evt_1",
            "created": 42.0,
            "type": "session.text.delta",
            "data": {
                "sessionID": "ses_1",
                "assistantMessageID": "msg_2",
                "ordinal": 0,
                "delta": "hello"
            },
            "durable": { "aggregateID": "ses_1", "seq": 7, "version": 1 }
        });
        let event = stream_event(&value).expect("event");
        assert_eq!(event.session_id, "ses_1");
        assert_eq!(event.delta.as_deref(), Some("hello"));
        assert_eq!(event.seq, Some(7));
        assert_eq!(event.assistant_message_id.as_deref(), Some("msg_2"));
    }

    #[test]
    fn non_session_events_are_dropped() {
        assert!(stream_event(&json!({ "type": "server.connected", "data": {} })).is_none());
        assert!(stream_event(&json!({ "type": "server.connected" })).is_none());
    }

    #[test]
    fn session_status_reports_its_type() {
        let event = stream_event(&json!({
            "type": "session.status",
            "created": 1.0,
            "data": { "sessionID": "ses_1", "status": { "type": "busy" } }
        }))
        .expect("event");
        assert_eq!(event.status.as_deref(), Some("busy"));
    }

    #[test]
    fn interrupt_reason_is_reported_as_status() {
        let event = stream_event(&json!({
            "type": "session.execution.interrupted",
            "created": 1.0,
            "data": { "sessionID": "ses_1", "reason": "user" }
        }))
        .expect("event");
        assert_eq!(event.status.as_deref(), Some("user"));
    }

    #[test]
    fn path_segments_are_encoded() {
        assert_eq!(encode_segment("ses_abc-1"), "ses_abc-1");
        assert_eq!(encode_segment("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn form_fields_keep_the_documented_shape() {
        let summary = form_summary(&json!({
            "id": "frm_1",
            "sessionID": "ses_1",
            "title": "Choose",
            "fields": [
                {
                    "key": "size",
                    "type": "multiselect",
                    "title": "Size",
                    "required": true,
                    "options": [{ "value": "s", "label": "Small" }]
                }
            ]
        }))
        .expect("form");
        assert_eq!(summary.id, "frm_1");
        assert_eq!(summary.fields.len(), 1);
        assert_eq!(summary.fields[0].kind, "multiselect");
        assert_eq!(summary.fields[0].options[0].label, "Small");
    }

    #[test]
    fn form_ipc_preserves_complete_raw_field_metadata() {
        let fields = json!([
            {"key":"text", "type":"string", "required":false, "default":"", "minLength":0,
             "maxLength":12, "pattern":"^[a-z]*$", "when":[{"key":"enabled","op":"eq","value":true}]},
            {"key":"number", "type":"number", "min":0,"max":10,"default":0},
            {"key":"enabled", "type":"boolean", "required":true,"default":false},
            {"key":"choice", "type":"select", "custom":true, "options":[{"value":"", "label":"Empty","description":"Keep"}]}
        ]);
        let form =
            form_summary(&json!({"id":"frm_fixture","sessionID":"ses_fixture","fields":fields}))
                .expect("form");
        let serialized = serde_json::to_value(form).expect("IPC");
        for (index, field) in fields.as_array().expect("fields").iter().enumerate() {
            assert_eq!(&serialized["fields"][index]["schema"], field);
        }
        assert_eq!(serialized["fields"][0]["required"], false);
        assert_eq!(serialized["fields"][2]["required"], true);
    }

    #[test]
    fn permission_payloads_are_bounded() {
        let summary = permission_summary(&json!({
            "id": "per_1",
            "sessionID": "ses_1",
            "action": "read",
            "resources": ["C:/a", "C:/b"],
            "message": "Allow read?"
        }))
        .expect("permission");
        assert_eq!(summary.action, "read");
        assert_eq!(summary.resources.len(), 2);
        assert_eq!(summary.message.as_deref(), Some("Allow read?"));
    }
}
