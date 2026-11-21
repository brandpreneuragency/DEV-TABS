//! Authenticated loopback relay. Its random credential stays in native and
//! plugin memory. Requests need an owned session and a real running tool call.
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::open_code::{Host, OpenCodeError, OpenCodeResult};

const LIMIT: usize = 64 * 1024;

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCall {
    pub session_id: String,
    pub admission_id: String,
    pub message_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub input: Value,
    pub stage: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub request_id: String,
    pub app_thread_id: String,
    #[serde(flatten)]
    pub call: ToolCall,
}

struct Binding {
    admission_id: String,
    tools: Vec<ToolSpec>,
}

pub type ToolSink = Arc<dyn Fn(ToolRequest) + Send + Sync>;

struct Pending {
    sender: mpsc::Sender<Value>,
    call: ToolCall,
}

pub struct Bridge {
    endpoint: String,
    token: String,
    stopped: AtomicBool,
    active: AtomicUsize,
    bindings: Mutex<HashMap<String, Binding>>,
    pending: Mutex<HashMap<String, Pending>>,
}

fn random_id() -> OpenCodeResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| OpenCodeError::new("internal", "Bridge random source is unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Bridge {
    fn check_binding(
        &self,
        session_id: &str,
        admission_id: &str,
        tools: &[ToolSpec],
    ) -> OpenCodeResult<()> {
        let bindings = self
            .bindings
            .lock()
            .map_err(|_| OpenCodeError::new("internal", "Bridge state is unavailable"))?;
        if self.stopped.load(Ordering::SeqCst) {
            return Err(OpenCodeError::unavailable(
                "TABS tool bridge is disconnected",
            ));
        }
        if bindings
            .get(session_id)
            .is_some_and(|old| old.admission_id == admission_id && old.tools != tools)
        {
            return Err(OpenCodeError::new(
                "conflict",
                "Captured tools changed for the same admission",
            ));
        }
        Ok(())
    }

    fn start(host: Weak<Host>, sink: ToolSink) -> OpenCodeResult<Arc<Self>> {
        let server = Server::http("127.0.0.1:0")
            .map_err(|_| OpenCodeError::new("internal", "TABS tool listener could not start"))?;
        let address = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| OpenCodeError::new("internal", "Invalid bridge address"))?;
        let bridge = Arc::new(Self {
            endpoint: format!("http://{address}/"),
            token: random_id()?,
            stopped: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            bindings: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || {
            while let Some(bridge) = weak.upgrade() {
                if bridge.stopped.load(Ordering::SeqCst) || host.upgrade().is_none() {
                    break;
                }
                let request = match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => request,
                    Ok(None) => continue,
                    Err(_) => break,
                };
                if bridge.active.fetch_add(1, Ordering::SeqCst) >= 8 {
                    bridge.active.fetch_sub(1, Ordering::SeqCst);
                    let _ = request.respond(Response::empty(StatusCode(503)));
                    continue;
                }
                let host = host.clone();
                let sink = sink.clone();
                std::thread::spawn(move || {
                    bridge.serve(request, host, sink);
                    bridge.active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Ok(bridge)
    }

    fn serve(&self, mut request: tiny_http::Request, host: Weak<Host>, sink: ToolSink) {
        let authorized = request.method() == &Method::Post
            && request.url() == "/call"
            && !request.headers().iter().any(|h| h.field.equiv("Origin"))
            && request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .is_some_and(|h| h.value.as_str() == format!("Bearer {}", self.token))
            && request.body_length().is_some_and(|length| length <= LIMIT);
        if !authorized {
            let _ = request.respond(Response::empty(StatusCode(403)));
            return;
        }
        let mut bytes = Vec::new();
        if request
            .as_reader()
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > LIMIT
        {
            let _ = request.respond(Response::empty(StatusCode(400)));
            return;
        }
        let result = serde_json::from_slice::<ToolCall>(&bytes)
            .ok()
            .and_then(|call| {
                let host = host.upgrade()?;
                if !matches!(call.stage.as_str(), "prepare" | "execute") || !call.input.is_object()
                {
                    return None;
                }
                {
                    let bindings = self.bindings.lock().ok()?;
                    let binding = bindings.get(&call.session_id)?;
                    if binding.admission_id != call.admission_id
                        || !binding.tools.iter().any(|tool| tool.name == call.tool_name)
                    {
                        return None;
                    }
                }
                if tauri::async_runtime::block_on(host.validate_tool_call(
                    &call.session_id,
                    &call.admission_id,
                    &call.message_id,
                    &call.call_id,
                    &call.tool_name,
                    &call.input,
                ))
                .is_err()
                {
                    return None;
                }
                let request_id = random_id().ok()?;
                let (send, receive) = mpsc::channel();
                self.pending.lock().ok()?.insert(
                    request_id.clone(),
                    Pending {
                        sender: send,
                        call: call.clone(),
                    },
                );
                sink(ToolRequest {
                    request_id: request_id.clone(),
                    app_thread_id: host.thread_id_for(&call.session_id)?,
                    call,
                });
                let result = receive.recv_timeout(Duration::from_secs(120)).ok();
                self.pending.lock().ok()?.remove(&request_id);
                if self.stopped.load(Ordering::SeqCst) {
                    return None;
                }
                result
            });
        let response = match result {
            Some(value) if value.get("error").is_none() => Response::from_string(value.to_string())
                .with_header(
                    Header::from_bytes("Content-Type", "application/json").expect("static header"),
                ),
            _ => Response::from_string("{\"error\":\"TABS request rejected or cancelled\"}")
                .with_status_code(StatusCode(409)),
        };
        let _ = request.respond(response);
    }

    pub fn complete(&self, request_id: &str, result: Value) -> OpenCodeResult<()> {
        if result.to_string().len() > LIMIT {
            return Err(OpenCodeError::new(
                "invalid_argument",
                "Tool result is too large",
            ));
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| OpenCodeError::new("internal", "Bridge state is unavailable"))?
            .remove(request_id)
            .ok_or_else(|| OpenCodeError::new("not_found", "Tool request expired"))?;
        pending
            .sender
            .send(result)
            .map_err(|_| OpenCodeError::new("not_found", "Tool request was cancelled"))
    }

    pub async fn validate(&self, host: &Host, request_id: &str) -> OpenCodeResult<()> {
        let call = self
            .pending
            .lock()
            .ok()
            .and_then(|pending| pending.get(request_id).map(|p| p.call.clone()))
            .ok_or_else(|| OpenCodeError::new("not_found", "Tool request expired"))?;
        let bound = self.bindings.lock().ok().is_some_and(|bindings| {
            bindings
                .get(&call.session_id)
                .is_some_and(|binding| binding.admission_id == call.admission_id)
        });
        if !bound || self.stopped.load(Ordering::SeqCst) {
            return Err(OpenCodeError::not_owned());
        }
        host.validate_tool_call(
            &call.session_id,
            &call.admission_id,
            &call.message_id,
            &call.call_id,
            &call.tool_name,
            &call.input,
        )
        .await
    }

    pub fn cancel_session(&self, session_id: &str) {
        if let Ok(mut bindings) = self.bindings.lock() {
            bindings.remove(session_id);
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|_, p| p.call.session_id != session_id);
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
        if let Ok(mut bindings) = self.bindings.lock() {
            bindings.clear();
        }
    }
}

pub async fn start(host: Arc<Host>, sink: ToolSink) -> OpenCodeResult<()> {
    let bridge = {
        let mut slot = host
            .bridge
            .lock()
            .map_err(|_| OpenCodeError::new("internal", "Bridge state is unavailable"))?;
        if let Some(bridge) = slot
            .as_ref()
            .filter(|bridge| !bridge.stopped.load(Ordering::SeqCst))
        {
            bridge.clone()
        } else {
            let bridge = Bridge::start(Arc::downgrade(&host), sink)?;
            *slot = Some(bridge.clone());
            bridge
        }
    };
    host.plugin_rpc(
        "configure",
        json!({ "endpoint": bridge.endpoint, "token": bridge.token }),
    )
    .await?;
    Ok(())
}

pub async fn bind(
    host: Arc<Host>,
    session_id: String,
    admission_id: String,
    tools: Vec<ToolSpec>,
) -> OpenCodeResult<()> {
    host.get_session(&session_id).await?;
    if !admission_id.starts_with("msg_")
        || tools.len() > 30
        || tools.iter().any(|tool| {
            !tool.name.starts_with("tabs_")
                || tool.name.len() > 100
                || !tool.input_schema.is_object()
        })
    {
        return Err(OpenCodeError::new(
            "invalid_argument",
            "Invalid TABS tool binding",
        ));
    }
    let bridge = host
        .bridge
        .lock()
        .ok()
        .and_then(|bridge| bridge.clone())
        .ok_or_else(|| OpenCodeError::unavailable("TABS tool bridge is disconnected"))?;
    bridge.check_binding(&session_id, &admission_id, &tools)?;
    host.plugin_rpc(
        "configure",
        json!({"endpoint": bridge.endpoint, "token": bridge.token}),
    )
    .await?;
    host.plugin_rpc(
        "bind",
        json!({"sessionID": session_id, "admissionID": admission_id, "tools": tools}),
    )
    .await?;
    bridge.check_binding(&session_id, &admission_id, &tools)?;
    // An old relay must not complete under the next captured turn.
    bridge
        .pending
        .lock()
        .map_err(|_| OpenCodeError::new("internal", "Bridge state is unavailable"))?
        .retain(|_, pending| {
            pending.call.session_id != session_id || pending.call.admission_id == admission_id
        });
    bridge
        .bindings
        .lock()
        .map_err(|_| OpenCodeError::new("internal", "Bridge state is unavailable"))?
        .insert(
            session_id,
            Binding {
                admission_id,
                tools,
            },
        );
    Ok(())
}

pub fn stop(host: &Host) {
    if let Ok(mut bridge) = host.bridge.lock() {
        if let Some(bridge) = bridge.take() {
            bridge.stop();
        }
    }
}

pub fn cancel_session(host: &Host, session_id: &str) {
    if let Ok(bridge) = host.bridge.lock() {
        if let Some(bridge) = bridge.as_ref() {
            bridge.cancel_session(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_preserve_identical_reconnect_and_reject_same_turn_schema_drift() {
        let bridge = Bridge {
            endpoint: String::new(),
            token: String::new(),
            stopped: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            bindings: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        };
        let tools = vec![ToolSpec {
            name: "tabs_document_read_v1".into(),
            description: "fixture".into(),
            input_schema: json!({"type":"object"}),
            read_only: true,
        }];
        bridge.bindings.lock().expect("bindings").insert(
            "ses_fixture".into(),
            Binding {
                admission_id: "msg_one".into(),
                tools: tools.clone(),
            },
        );
        assert!(bridge
            .check_binding("ses_fixture", "msg_one", &tools)
            .is_ok());
        assert!(bridge.check_binding("ses_fixture", "msg_one", &[]).is_err());
        assert!(bridge.check_binding("ses_fixture", "msg_two", &[]).is_ok());
        bridge.stop();
        assert!(bridge.check_binding("ses_fixture", "msg_two", &[]).is_err());
    }

    #[test]
    fn loopback_listener_rejects_unauthenticated_foreign_and_browser_calls() {
        let directory = tempfile::tempdir().expect("fixture");
        let host =
            Arc::new(Host::new(directory.path().to_path_buf(), Box::new(|_| {})).expect("host"));
        let bridge = Bridge::start(
            Arc::downgrade(&host),
            Arc::new(|_| panic!("foreign call reached WebView")),
        )
        .expect("listener");
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("client");
        let body = json!({"sessionId":"ses_foreign", "admissionId":"msg_user", "messageId":"msg_assistant",
            "callId":"call", "toolName":"tabs_tasks_create_v1", "input":{}, "stage":"execute"});
        let response = client
            .post(format!("{}call", bridge.endpoint))
            .json(&body)
            .send()
            .expect("response");
        assert_eq!(response.status().as_u16(), 403);
        let response = client
            .post(format!("{}call", bridge.endpoint))
            .bearer_auth(&bridge.token)
            .header("Origin", "http://untrusted.invalid")
            .json(&body)
            .send()
            .expect("response");
        assert_eq!(response.status().as_u16(), 403);
        let response = client
            .post(format!("{}call", bridge.endpoint))
            .bearer_auth(&bridge.token)
            .json(&body)
            .send()
            .expect("response");
        assert_eq!(response.status().as_u16(), 409);
        assert!(bridge.complete("invented", json!({"text":"no"})).is_err());
        bridge.stop();
        assert!(bridge.stopped.load(Ordering::SeqCst));
    }
}
