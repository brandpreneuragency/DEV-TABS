//! Read-only Grok Build ACP account observer. Never exports credentials.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::model::Identity;
use crate::codex::CliOwnedJob;
use serde_json::{json, Value};

use sha2::{Digest, Sha256};

fn metadata(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

fn parse_identity(value: &Value) -> Option<Identity> {
    let principal = metadata(value, "principalId")?;
    let kind = metadata(value, "principalType")?;
    let team = metadata(value, "teamId");
    let organization = metadata(value, "organizationId");
    // Missing optional workspace is distinct from a non-null invalid workspace.
    for key in ["teamId", "organizationId"] {
        if value.get(key).is_some_and(|v| !v.is_null()) && metadata(value, key).is_none() {
            return None;
        }
    }
    let key = Sha256::digest(
        serde_json::to_vec(&("grok-build", kind, principal, &team, &organization)).ok()?,
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
    Some(Identity {
        key,
        email: metadata(value, "email"),
        workspace_id: team.or(organization),
        plan: None,
    })
}

fn parse_billing(value: &Value) -> Result<Option<super::model::BillingUsage>, String> {
    let config = value.get("config").ok_or("grok_billing_invalid")?;
    if config.is_null() {
        return Ok(None);
    }
    if !config.is_object() {
        return Err("grok_billing_invalid".into());
    }
    let used_percent = match config.get("creditUsagePercent").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => Some(
            v.as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or("grok_billing_invalid")?,
        ),
    };
    let current = config.get("currentPeriod").filter(|v| !v.is_null());
    if current.is_some_and(|v| !v.is_object()) {
        return Err("grok_billing_invalid".into());
    }
    let period = match current.and_then(|v| v.get("type")).and_then(Value::as_str) {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => Some("weekly".into()),
        Some("USAGE_PERIOD_TYPE_MONTHLY") => Some("monthly".into()),
        _ => None,
    };
    // Preserve the vendor's RFC3339 value; never manufacture a monthly duration
    // or infer a refill from the local clock.
    let resets_at = current.and_then(|v| metadata(v, "end"));
    let prepaid_balance_cents = match config.get("prepaidBalance").filter(|v| !v.is_null()) {
        None => None,
        Some(v) if v.is_object() => Some(match v.get("val") {
            None => 0, // proto3 omits zero scalars, so {} is a known zero.
            Some(v) => v
                .as_i64()
                .filter(|v| *v >= 0)
                .ok_or("grok_billing_invalid")?,
        }),
        _ => return Err("grok_billing_invalid".into()),
    };
    Ok(Some(super::model::BillingUsage {
        used_percent,
        period,
        resets_at,
        prepaid_balance_cents,
    }))
}

#[derive(Debug)]
pub(super) struct GrokSnapshot {
    pub identity: Option<Identity>,
    pub usage: Option<super::model::Usage>,
    pub usage_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operation {
    Initialize,
    AuthInfo,
    Billing,
}

fn collect(
    mut rpc: impl FnMut(Operation) -> Result<Value, String>,
) -> Result<GrokSnapshot, String> {
    let initialized = rpc(Operation::Initialize)?;
    if initialized.get("protocolVersion").and_then(Value::as_u64) != Some(1)
        || initialized
            .pointer("/_meta/grokShell")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Err("grok_protocol_unsupported".into());
    }
    let before = rpc(Operation::AuthInfo)?;
    let Some(owner) = parse_identity(&before) else {
        let signed_out = [
            "methodId",
            "principalId",
            "principalType",
            "teamId",
            "organizationId",
            "email",
        ]
        .iter()
        .all(|field| before.get(field).map_or(true, Value::is_null));
        return Ok(GrokSnapshot {
            identity: None,
            usage: None,
            usage_error: (!signed_out).then(|| "grok_identity_unavailable".into()),
        });
    };
    // auth/info is cached metadata, NOT live authentication. Billing's own
    // auth gate uses the agent's current valid auth (not methodId). No login,
    // authenticate, session or token-export operation is needed or permitted.
    // ACP does not advertise a billing-method registry: the read itself proves
    // support, and -32601 must stay an honest unsupported result, not a fallback.
    let billing = rpc(Operation::Billing);
    let after = rpc(Operation::AuthInfo)?;
    let Some(mut identity) = parse_identity(&after).filter(|v| v.key == owner.key) else {
        return Err("grok_identity_changed".into());
    };
    let billing = match billing {
        Ok(value) => value,
        Err(error) => {
            return Ok(GrokSnapshot {
                identity: Some(identity),
                usage: None,
                usage_error: Some(error),
            })
        }
    };
    identity.plan = metadata(&billing, "subscription_tier");
    match parse_billing(&billing) {
        Ok(Some(billing)) => Ok(GrokSnapshot {
            identity: Some(identity),
            usage: Some(super::model::Usage {
                windows: vec![],
                reset_tokens: None,
                billing: Some(billing),
                reset_credits: None,
                reset_credits_error: None,
                reset_credits_next_check_at: None,
            }),
            usage_error: None,
        }),
        result => Ok(GrokSnapshot {
            identity: Some(identity),
            usage: None,
            usage_error: Some(match result {
                Err(error) => error,
                _ => "grok_billing_unavailable".into(),
            }),
        }),
    }
}

const MAX_FRAME: u64 = 256 * 1024;
const MAX_FRAMES: usize = 64;
const LIFETIME: Duration = Duration::from_secs(45);
const RPC_TIMEOUT: Duration = Duration::from_secs(20);

impl Operation {
    fn wire(self) -> (&'static str, Value) {
        match self {
            Self::Initialize => (
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"tabs-provider-accounts","version":"1"}}),
            ),
            // agent-client-protocol 0.10.4 prepends exactly one underscore to
            // ExtRequest.method; params and result are raw JSON (not wrapped).
            Self::AuthInfo => ("_x.ai/auth/info", json!({})),
            Self::Billing => ("_x.ai/billing", json!({})),
        }
    }
}

struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: mpsc::Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    job: Arc<CliOwnedJob>,
    stopped: Arc<(Mutex<bool>, Condvar)>,
    watchdog: Option<JoinHandle<()>>,
    deadline: Instant,
    next_id: u64,
    seen: usize,
}

fn read_frames(input: impl Read, tx: mpsc::SyncSender<Value>) {
    let mut input = BufReader::new(input);
    for _ in 0..MAX_FRAMES {
        let mut bytes = Vec::new();
        if !matches!(input.by_ref().take(MAX_FRAME + 1).read_until(b'\n', &mut bytes), Ok(n) if n > 0)
            || bytes.len() as u64 > MAX_FRAME
            || bytes.last() != Some(&b'\n')
        {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            return;
        };
        if !value.is_object() || tx.try_send(value).is_err() {
            return;
        }
    }
}

impl Client {
    fn start(home: &Path) -> Result<Self, String> {
        let mut command =
            super::external_cli::command("grok", home).map_err(|_| "grok_cli_unavailable")?;
        // 1.0.44 accepts this as a top-level flag, not after `agent stdio`.
        command
            .args(["--no-auto-update", "agent", "stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|_| "grok_start_failed")?;
        let job = match CliOwnedJob::assign(&child) {
            Ok(job) => Arc::new(job),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("grok_process_ownership_failed".into());
            }
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("grok_stdio_unavailable".into());
        };
        let (tx, frames) = mpsc::sync_channel(16);
        let reader = std::thread::spawn(move || read_frames(stdout, tx));
        let stopped = Arc::new((Mutex::new(false), Condvar::new()));
        let signal = stopped.clone();
        let kill = job.clone();
        let watchdog = std::thread::spawn(move || {
            let (lock, cv) = &*signal;
            if let Ok(guard) = lock.lock() {
                match cv.wait_timeout_while(guard, LIFETIME, |done| !*done) {
                    Ok((done, _)) if *done => {}
                    _ => kill.terminate(),
                }
            } else {
                kill.terminate();
            }
        });
        Ok(Self {
            child,
            stdin: Some(stdin),
            frames,
            reader: Some(reader),
            job,
            stopped,
            watchdog: Some(watchdog),
            deadline: Instant::now() + LIFETIME,
            next_id: 1,
            seen: 0,
        })
    }

    fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "grok_request_invalid")?;
        // Only four fixed small requests, plus at most one denial. Never write
        // a server-controlled large id or arbitrary caller-supplied params.
        if bytes.len() > 2048 {
            return Err("grok_request_invalid".into());
        }
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().ok_or("grok_process_closed")?;
        stdin
            .write_all(&bytes)
            .and_then(|_| stdin.flush())
            .map_err(|_| "grok_process_closed".into())
    }

    fn rpc(&mut self, operation: Operation) -> Result<Value, String> {
        if self.next_id > 4 || Instant::now() >= self.deadline {
            return Err("grok_deadline_exceeded".into());
        }
        let id = self.next_id;
        self.next_id += 1;
        let (method, params) = operation.wire();
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let deadline = self.deadline.min(Instant::now() + RPC_TIMEOUT);
        loop {
            let value = self
                .frames
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "grok_timeout_or_closed")?;
            self.seen += 1;
            if self.seen > MAX_FRAMES || Instant::now() >= deadline {
                return Err("grok_deadline_exceeded".into());
            }
            if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                return Err("grok_response_invalid".into());
            }
            if value.get("method").is_some() {
                if let Some(server_id) = value.get("id") {
                    // No fs, terminal, permission or tool reverse request is
                    // authorized, even if its id collides with our request.
                    if server_id.is_i64()
                        || server_id.is_u64()
                        || server_id.as_str().is_some_and(|s| s.len() <= 128)
                    {
                        self.send(json!({"jsonrpc":"2.0","id":server_id,"error":{"code":-32601,"message":"Account observer denies server requests"}}))?;
                    }
                    return Err("grok_server_request_denied".into());
                }
                continue;
            }
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                return Err("grok_response_id_mismatch".into());
            }
            return response_result(operation, &value);
        }
    }
}

fn response_result(operation: Operation, value: &Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        // Never return raw message/data: provider errors can contain secrets.
        return Err(match error.get("code").and_then(Value::as_i64) {
            Some(-32601) => "grok_method_unsupported",
            _ if operation == Operation::Billing => "grok_billing_failed",
            _ => "grok_protocol_failed",
        }
        .into());
    }
    value
        .get("result")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| "grok_response_invalid".into())
}

impl Drop for Client {
    fn drop(&mut self) {
        self.stdin.take();
        self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
        let (lock, cv) = &*self.stopped;
        if let Ok(mut done) = lock.lock() {
            *done = true;
            cv.notify_all();
        }
        if let Some(handle) = self.watchdog.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

/// Cached identity is not a connected-account claim. Only successful billing
/// supplies fresh usage; the parent must keep failed refreshes stale and apply
/// its own slot/generation guard before persisting this synchronous result.
pub(super) fn observe(home: &Path) -> Result<GrokSnapshot, String> {
    let mut client = Client::start(home)?;
    let snapshot = collect(|op| client.rpc(op))?;
    if Instant::now() >= client.deadline {
        return Err("grok_deadline_exceeded".into());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_billing_is_unknown_and_legacy_money_is_not_quota() {
        assert!(parse_billing(&json!({"config":null})).unwrap().is_none());
        assert!(parse_billing(&json!({})).is_err());
        let v = parse_billing(&json!({"config":{"monthlyLimit":{"val":1000},"used":{"val":500}}}))
            .unwrap()
            .unwrap();
        assert_eq!(v.used_percent, None);
        assert_eq!(v.prepaid_balance_cents, None);
        assert_eq!(v.period, None);
        assert_eq!(v.resets_at, None);
    }

    #[test]
    fn negative_and_non_numeric_billing_fields_fail_closed() {
        for config in [
            json!({"creditUsagePercent":-1}),
            json!({"creditUsagePercent":"50"}),
            json!({"prepaidBalance":{"val":-1}}),
            json!({"prepaidBalance":{"val":1.5}}),
            json!({"prepaidBalance":{"val":null}}),
            json!({"prepaidBalance":{"val":18446744073709551615u64}}),
            json!({"prepaidBalance":0}),
            json!({"currentPeriod":[]}),
        ] {
            assert_eq!(
                parse_billing(&json!({"config":config})).unwrap_err(),
                "grok_billing_invalid"
            );
        }
    }

    #[test]
    fn over_limit_is_preserved_not_clamped_and_unknown_period_stays_unknown() {
        let v = parse_billing(&json!({"config":{"creditUsagePercent":101.5,"currentPeriod":{"type":"future-period"},"prepaidBalance":{"val":1250}}})).unwrap().unwrap();
        assert_eq!(v.used_percent, Some(101.5));
        assert_eq!(v.period, None);
        assert_eq!(v.prepaid_balance_cents, Some(1250));
        let v = parse_billing(
            &json!({"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY"}}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(v.period.as_deref(), Some("monthly"));
    }

    #[test]
    fn absent_identity_never_calls_billing_or_authenticate() {
        let mut calls = vec![];
        let snapshot = collect(|op| {
            calls.push(op);
            Ok(match op {
                Operation::Initialize => json!({"protocolVersion":1,"_meta":{"grokShell":true},"authMethods":[{"id":"cached_token"}]}),
                Operation::AuthInfo => json!({"methodId":null,"email":"not-an-identity@example.invalid","principalId":null}),
                Operation::Billing => panic!("must not fetch unowned quota"),
            })
        }).unwrap();
        assert_eq!(calls, [Operation::Initialize, Operation::AuthInfo]);
        assert!(snapshot.identity.is_none() && snapshot.usage.is_none());
    }

    #[test]
    fn signed_out_is_not_a_failed_quota_check() {
        let snapshot = collect(|op| {
            Ok(match op {
                Operation::Initialize => json!({"protocolVersion":1,"_meta":{"grokShell":true}}),
                Operation::AuthInfo => json!({"methodId":null,"principalId":null,"email":null}),
                Operation::Billing => panic!("signed-out observer must not fetch billing"),
            })
        })
        .unwrap();
        assert!(snapshot.identity.is_none());
        assert!(snapshot.usage.is_none());
        assert!(snapshot.usage_error.is_none());
    }

    #[test]
    fn unknown_or_disappearing_identity_after_billing_is_rejected() {
        let mut info_calls = 0;
        let result = collect(|op| {
            Ok(match op {
                Operation::Initialize => json!({"protocolVersion":1,"_meta":{"grokShell":true}}),
                Operation::AuthInfo => {
                    info_calls += 1;
                    if info_calls == 1 {
                        principal()
                    } else {
                        json!({})
                    }
                }
                Operation::Billing => json!({"config":{}}),
            })
        });
        assert_eq!(result.unwrap_err(), "grok_identity_changed");
    }

    #[test]
    fn known_owner_billing_failure_is_not_live_auth_success() {
        let snapshot = collect(|op| match op {
            Operation::Initialize => Ok(json!({"protocolVersion":1,"_meta":{"grokShell":true}})),
            Operation::AuthInfo => Ok(principal()),
            Operation::Billing => Err("grok_method_unsupported".into()),
        })
        .unwrap();
        assert!(snapshot.identity.is_some());
        assert!(snapshot.usage.is_none());
        assert_eq!(
            snapshot.usage_error.as_deref(),
            Some("grok_method_unsupported")
        );
    }

    #[test]
    fn successful_owned_usage_uses_snake_case_tier_only() {
        for field in ["subscription_tier", "subscriptionTier"] {
            let snapshot = collect(|op| {
                Ok(match op {
                    Operation::Initialize => {
                        json!({"protocolVersion":1,"_meta":{"grokShell":true}})
                    }
                    Operation::AuthInfo => principal(),
                    Operation::Billing => {
                        let mut value = json!({"config":{"creditUsagePercent":10}});
                        value[field] = json!("SuperGrok");
                        value
                    }
                })
            })
            .unwrap();
            assert_eq!(
                snapshot.identity.unwrap().plan.as_deref(),
                if field == "subscription_tier" {
                    Some("SuperGrok")
                } else {
                    None
                }
            );
            let usage = snapshot.usage.unwrap();
            assert_eq!(usage.billing.unwrap().used_percent, Some(10.0));
            assert!(usage.windows.is_empty());
            assert!(usage.reset_tokens.is_none());
            assert!(snapshot.usage_error.is_none());
        }
    }

    #[test]
    fn principal_type_organization_and_team_each_participate_in_key() {
        let key = parse_identity(&principal()).unwrap().key;
        for field in ["principalType", "principalId", "organizationId", "teamId"] {
            let mut v = principal();
            v[field] = json!("different");
            assert_ne!(parse_identity(&v).unwrap().key, key);
        }
        let mut invalid = principal();
        invalid["teamId"] = json!("");
        assert!(parse_identity(&invalid).is_none());
        invalid["teamId"] = json!(123);
        assert!(parse_identity(&invalid).is_none());
    }

    #[test]
    fn incorrect_protocol_or_non_grok_peer_never_reads_identity() {
        for init in [
            json!({"protocolVersion":2,"_meta":{"grokShell":true}}),
            json!({"protocolVersion":1}),
            json!({"protocolVersion":1,"_meta":{"grokShell":false}}),
        ] {
            assert_eq!(
                collect(|op| {
                    assert_eq!(op, Operation::Initialize);
                    Ok(init.clone())
                })
                .unwrap_err(),
                "grok_protocol_unsupported"
            );
        }
    }

    #[test]
    fn wire_uses_sdk_underscore_and_no_extension_envelope() {
        assert_eq!(Operation::AuthInfo.wire(), ("_x.ai/auth/info", json!({})));
        assert_eq!(Operation::Billing.wire(), ("_x.ai/billing", json!({})));
        let (_, init) = Operation::Initialize.wire();
        assert_eq!(
            init.pointer("/clientCapabilities/fs/readTextFile"),
            Some(&json!(false))
        );
        assert_eq!(
            init.pointer("/clientCapabilities/fs/writeTextFile"),
            Some(&json!(false))
        );
        assert_eq!(
            init.pointer("/clientCapabilities/terminal"),
            Some(&json!(false))
        );
    }

    #[test]
    fn rpc_errors_never_export_provider_message_or_data() {
        for (code, expected) in [
            (-32601, "grok_method_unsupported"),
            (-32000, "grok_billing_failed"),
        ] {
            assert_eq!(response_result(Operation::Billing, &json!({"error":{"code":code,"message":"synthetic-secret","data":{"token":"synthetic-secret"}}})).unwrap_err(), expected);
        }
        assert!(response_result(Operation::Billing, &json!({"result":null})).is_err());
    }

    #[test]
    fn jsonl_reader_rejects_large_invalid_and_unterminated_frames() {
        for bytes in [
            vec![b'a'; MAX_FRAME as usize + 1],
            b"not json\n".to_vec(),
            b"{}".to_vec(),
            b"[]\n".to_vec(),
        ] {
            let (tx, rx) = mpsc::sync_channel(1);
            read_frames(bytes.as_slice(), tx);
            assert!(rx.try_recv().is_err());
        }
        let (tx, rx) = mpsc::sync_channel(1);
        read_frames(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n".as_slice(),
            tx,
        );
        assert_eq!(rx.try_recv().unwrap()["id"], json!(1));
    }

    #[test]
    fn jsonl_reader_is_bounded_even_if_peer_overproduces() {
        let (tx, rx) = mpsc::sync_channel(2);
        read_frames(b"{}\n{}\n{}\n{}\n".as_slice(), tx);
        assert_eq!(rx.try_iter().count(), 2);
    }

    /// Opt-in, exact-filter only. The caller supplies an existing SCRATCH root;
    /// this test creates a new empty home, never uses the owner's Grok home.
    #[test]
    #[ignore = "installed Grok signed-out ACP only; set TABS_GROK_SIGNEDOUT_SMOKE_ROOT to isolated scratch"]
    fn installed_grok_signedout_protocol_smoke() {
        let root = std::env::var_os("TABS_GROK_SIGNEDOUT_SMOKE_ROOT")
            .expect("explicit scratch root required");
        let home = std::path::PathBuf::from(root).join(format!(
            "tabs-grok-acp-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&home).expect("new empty home required");
        let mut client = Client::start(&home).unwrap();
        let initialized = client.rpc(Operation::Initialize).unwrap();
        assert_eq!(initialized["protocolVersion"], json!(1));
        assert_eq!(initialized.pointer("/_meta/grokShell"), Some(&json!(true)));
        let before = client.rpc(Operation::AuthInfo).unwrap();
        assert!(
            parse_identity(&before).is_none(),
            "smoke must be signed out"
        );
        assert!(
            metadata(&before, "email").is_none(),
            "smoke must not load owner metadata"
        );
        assert_eq!(
            client.rpc(Operation::Billing).unwrap_err(),
            "grok_billing_failed"
        );
        let after = client.rpc(Operation::AuthInfo).unwrap();
        assert!(parse_identity(&after).is_none());
        let transcript = json!({"initialize":"protocol-v1-grok","_x.ai/auth/info":"signed-out-before-and-after","_x.ai/billing":"grok_billing_failed","requests":4,"login":false,"inference":false});
        drop(client); // synchronous Job Object tree termination and reader joins
        std::fs::write(
            home.join("transcript-sanitized.json"),
            serde_json::to_vec_pretty(&transcript).unwrap(),
        )
        .unwrap();
        let snapshot = observe(&home).unwrap();
        assert!(snapshot.identity.is_none() && snapshot.usage.is_none());
        eprintln!(
            "signed-out ACP artifact: {}",
            home.join("transcript-sanitized.json").display()
        );
    }

    fn principal() -> Value {
        json!({"principalType":"user", "principalId":"principal-1", "teamId":"team-1", "organizationId":"org-1", "email":"display@example.invalid"})
    }

    #[test]
    fn new_billing_shape_preserves_reported_period_and_prepaid_zero() {
        let billing = parse_billing(&json!({"config": {"creditUsagePercent":42.5, "currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY", "end":"2026-10-27T00:00:00+03:00"}, "prepaidBalance":{}}})).unwrap().unwrap();
        assert_eq!(billing.used_percent, Some(42.5));
        assert_eq!(billing.period.as_deref(), Some("weekly"));
        assert_eq!(
            billing.resets_at.as_deref(),
            Some("2026-10-27T00:00:00+03:00")
        );
        assert_eq!(billing.prepaid_balance_cents, Some(0));
    }

    #[test]
    fn ownership_change_during_billing_discards_snapshot() {
        let mut calls = 0;
        let result = collect(|op| {
            calls += 1;
            Ok(match op {
                Operation::Initialize => json!({"protocolVersion":1,"_meta":{"grokShell":true}}),
                Operation::AuthInfo => {
                    let mut v = principal();
                    if calls > 2 {
                        v["principalId"] = json!("other");
                    }
                    v
                }
                Operation::Billing => json!({"config":{"creditUsagePercent":25}}),
            })
        });
        assert_eq!(result.unwrap_err(), "grok_identity_changed");
        assert_eq!(calls, 4);
    }

    #[test]
    fn stable_principal_and_workspace_own_identity_not_email() {
        let original = parse_identity(&principal()).unwrap();
        let mut changed = principal();
        changed["email"] = json!("renamed@example.invalid");
        assert_eq!(original.key, parse_identity(&changed).unwrap().key);
        changed["teamId"] = json!("team-2");
        assert_ne!(original.key, parse_identity(&changed).unwrap().key);
        changed = principal();
        changed["principalId"] = Value::Null;
        assert!(parse_identity(&changed).is_none());
    }
}
