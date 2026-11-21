use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub key: String,
    pub email: Option<String>,
    pub workspace_id: Option<String>,
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageWindow {
    pub id: String,
    pub window_minutes: i64,
    pub used_percent: Option<f64>,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub windows: Vec<UsageWindow>,
    pub reset_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<BillingUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<ResetCredits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits_error: Option<ResetCreditsError>,
    /// Persist the grant cadence so reopening the app does not poll it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits_next_check_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetCredits {
    pub available_count: i64,
    pub credits: Vec<ResetCredit>,
    pub details_complete: bool,
    pub observed_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetCredit {
    pub kind: ResetKind,
    pub count: i64,
    pub expires_at: Option<i64>,
    pub expiry_known: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ResetKind {
    Session,
    Weekly,
    Fable,
    Full,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ResetCreditsError {
    Unavailable,
    Surface,
}

pub(super) fn reset_count(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
}

pub(super) fn expiry_millis(
    value: Option<&Value>,
    parse: impl FnOnce(&Value) -> Option<i64>,
) -> (Option<i64>, bool) {
    match value {
        Some(Value::Null) => (None, true),
        Some(value) => {
            let timestamp = parse(value).filter(|n| (0..=8_640_000_000_000_000).contains(n));
            (timestamp, timestamp.is_some())
        }
        None => (None, false),
    }
}

fn codex_reset_credits(value: &Value) -> Option<ResetCredits> {
    let available_count = reset_count(value.get("availableCount")?)?;
    let rows = value.get("credits").and_then(Value::as_array);
    let mut credits = Vec::new();
    let mut complete = rows.is_some_and(|rows| rows.len() <= 256);
    for row in rows.into_iter().flatten().take(256) {
        match row.get("status").and_then(Value::as_str) {
            Some("available") => {}
            Some("used" | "expired" | "revoked") => continue,
            _ => {
                complete = false;
                continue;
            }
        }
        let (expires_at, expiry_known) =
            expiry_millis(row.get("expiresAt"), |v| v.as_i64()?.checked_mul(1000));
        complete &= expiry_known;
        credits.push(ResetCredit {
            kind: ResetKind::Unknown,
            count: 1,
            expires_at,
            expiry_known,
        });
    }
    complete &= credits.len() as i64 == available_count;
    // Contradictory detail rows cannot advertise more rights than the count.
    if credits.len() as i64 > available_count {
        credits.clear();
    }
    Some(ResetCredits {
        available_count,
        credits,
        details_complete: complete,
        observed_at: super::now(),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BillingUsage {
    pub used_percent: Option<f64>,
    pub period: Option<String>,
    /// Provider-reported RFC3339 time; never inferred from a calendar month.
    pub resets_at: Option<String>,
    pub prepaid_balance_cents: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AccountStatus {
    Disconnected,
    Configured,
    Connected,
    AuthRequired,
    Error,
    Duplicate,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAccount {
    pub id: String,
    pub provider_id: String,
    pub label: String,
    pub identity: Option<Identity>,
    pub status: AccountStatus,
    pub duplicate_of: Option<String>,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub error: Option<String>,
    pub usage: Option<Usage>,
}

pub fn initial_accounts() -> Vec<ProviderAccount> {
    (1..=4)
        .map(|n| ProviderAccount {
            id: format!("codex-{n}"),
            provider_id: "openai-codex".into(),
            label: format!("Codex {n}"),
            identity: None,
            status: AccountStatus::Disconnected,
            duplicate_of: None,
            last_attempt_at: None,
            last_success_at: None,
            error: None,
            usage: None,
        })
        .collect()
}

pub fn slot_index(id: &str) -> Result<usize, String> {
    initial_accounts()
        .iter()
        .position(|a| a.id == id)
        .ok_or_else(|| "Unknown provider account slot".into())
}

pub fn parse_usage(value: &Value) -> Result<Usage, String> {
    let bucket = value
        .get("rateLimitsByLimitId")
        .and_then(|b| b.get("codex"))
        .or_else(|| value.get("rateLimits"))
        .filter(|v| v.is_object())
        .ok_or("Codex returned an invalid rate-limit snapshot")?;
    let mut windows = Vec::new();
    for name in ["primary", "secondary"] {
        let Some(w) = bucket.get(name).filter(|w| w.is_object()) else {
            continue;
        };
        let Some(minutes) = w
            .get("windowDurationMins")
            .and_then(Value::as_i64)
            .filter(|m| *m > 0)
        else {
            continue;
        };
        let id = match minutes {
            300 => "fiveHour".into(),
            10080 => "weekly".into(),
            m => format!("minutes-{m}"),
        };
        if windows.iter().any(|w: &UsageWindow| w.id == id) {
            continue;
        }
        windows.push(UsageWindow {
            id,
            window_minutes: minutes,
            used_percent: w
                .get("usedPercent")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0),
            resets_at: w
                .get("resetsAt")
                .and_then(Value::as_i64)
                .filter(|n| *n >= 0)
                .and_then(|n| n.checked_mul(1000)),
        });
    }
    windows.sort_by_key(|w| w.window_minutes);
    Ok(Usage {
        windows,
        billing: None,
        reset_credits: value
            .get("rateLimitResetCredits")
            .and_then(codex_reset_credits),
        reset_credits_error: None,
        reset_credits_next_check_at: None,
        reset_tokens: value
            .pointer("/rateLimitResetCredits/availableCount")
            .and_then(reset_count),
    })
}

/// Only non-secret claims extracted from the exact slot's Codex-owned encrypted auth.
/// This is local ownership metadata, NOT JWT signature validation or remote authorization.
pub fn identity_from_claims(account: &Value, auth: &Value) -> Option<Identity> {
    let info = account.get("account")?;
    if info.get("type")?.as_str()? != "chatgpt" {
        return None;
    }
    let claims = auth.get("https://api.openai.com/auth")?;
    let principal = claims
        .get("chatgpt_user_id")
        .or_else(|| claims.get("user_id"))
        .and_then(Value::as_str)
        .filter(|s| valid_id(s))?;
    let workspace = account
        .pointer("/workspaceRouting/chatgptAccountId")
        .and_then(Value::as_str)
        .or_else(|| claims.get("chatgpt_account_id").and_then(Value::as_str))
        .filter(|s| valid_id(s))?;
    if claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .is_some_and(|s| s != workspace)
    {
        return None;
    }
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&("openai-codex", principal, workspace)).ok()?)
    );
    Some(Identity {
        key,
        email: info.get("email").and_then(Value::as_str).map(str::to_owned),
        workspace_id: Some(workspace.into()),
        plan: info
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 1024 && s.trim() == s && !s.chars().any(char::is_control)
}

pub fn apply_identity(account: &mut ProviderAccount, identity: Option<Identity>) {
    let same = account
        .identity
        .as_ref()
        .zip(identity.as_ref())
        .is_some_and(|(a, b)| a.key == b.key);
    if !same {
        account.usage = None;
        account.last_success_at = None;
    }
    account.identity = identity;
    account.duplicate_of = None;
}

pub fn mark_error(account: &mut ProviderAccount, now: i64, message: &str) {
    account.last_attempt_at = Some(now);
    account.status = AccountStatus::Error;
    account.error = Some(message.into());
}

pub fn mark_duplicates(accounts: &mut [ProviderAccount]) {
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for a in accounts {
        a.duplicate_of = None;
        if a.status == AccountStatus::Duplicate {
            a.status = AccountStatus::Connected;
        }
        if let Some(identity) = &a.identity {
            if let Some(id) = seen.get(&identity.key) {
                a.duplicate_of = Some(id.clone());
                // Preserve errors/auth-required rather than masking a failed observation.
                if a.status == AccountStatus::Connected {
                    a.status = AccountStatus::Duplicate;
                }
            } else {
                seen.insert(identity.key.clone(), a.id.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn banked_codex_resets_keep_authoritative_count_and_sanitized_expiry_details() {
        let usage = parse_usage(&json!({"rateLimits":{},"rateLimitResetCredits":{
            "availableCount":4,"credits":[
                {"id":"private-redemption-id","status":"available","resetType":"codexRateLimits","expiresAt":1900000000},
                {"status":"available","expiresAt":null},
                {"status":"used","expiresAt":1900000000},
                {"status":"available"}
            ]}})).unwrap();
        let value = serde_json::to_value(usage).unwrap();
        assert_eq!(value["resetCredits"]["availableCount"], 4);
        assert_eq!(
            value["resetCredits"]["credits"].as_array().unwrap().len(),
            3
        );
        assert_eq!(
            value["resetCredits"]["credits"][0]["expiresAt"],
            1900000000000i64
        );
        assert_eq!(value["resetCredits"]["credits"][1]["expiryKnown"], true);
        assert_eq!(value["resetCredits"]["credits"][2]["expiryKnown"], false);
        assert_eq!(value["resetCredits"]["detailsComplete"], false);
        assert!(!value.to_string().contains("private-redemption-id"));
    }
    #[test]
    fn banked_codex_partial_capped_and_invalid_details_never_replace_the_count() {
        for credits in [
            serde_json::Value::Null,
            json!([]),
            json!([{"status":"available","expiresAt":-1}]),
            json!([{"status":"available","expiresAt":i64::MAX}]),
        ] {
            let usage = parse_usage(&json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":7,"credits":credits}})).unwrap();
            let inventory = usage.reset_credits.unwrap();
            assert_eq!(inventory.available_count, 7);
            assert!(!inventory.details_complete);
        }
        let rows: Vec<_> = (0..300)
            .map(|_| json!({"status":"available","expiresAt":null}))
            .collect();
        let usage = parse_usage(
            &json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":300,"credits":rows}}),
        )
        .unwrap();
        let inventory = usage.reset_credits.unwrap();
        assert_eq!(inventory.available_count, 300);
        assert_eq!(inventory.credits.len(), 256);
        assert!(!inventory.details_complete);
        for count in [json!(-1), json!(1.5), json!("7"), json!(i64::MAX)] {
            let usage = parse_usage(&json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":count,"credits":[]}})).unwrap();
            assert!(usage.reset_tokens.is_none() && usage.reset_credits.is_none());
        }
        let zero = parse_usage(
            &json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":0,"credits":[]}}),
        )
        .unwrap();
        assert_eq!(zero.reset_tokens, Some(0));
        assert!(zero.reset_credits.unwrap().details_complete);
    }
    #[test]
    fn banked_codex_never_displays_more_detail_rights_than_the_authoritative_count() {
        let usage = parse_usage(&json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":0,"credits":[{"status":"available","expiresAt":null}]}})).unwrap();
        let inventory = usage.reset_credits.unwrap();
        assert_eq!(inventory.available_count, 0);
        assert!(inventory.credits.is_empty());
        assert!(!inventory.details_complete);
    }
    #[test]
    fn banked_inventory_is_optional_for_existing_snapshots_and_round_trips_without_provider_ids() {
        let legacy: Usage = serde_json::from_value(json!({"windows":[],"resetTokens":3})).unwrap();
        assert!(legacy.reset_credits.is_none());
        let usage = parse_usage(&json!({"rateLimits":{},"rateLimitResetCredits":{"availableCount":1,"credits":[{"id":"not-for-ipc","status":"available","expiresAt":null}]}})).unwrap();
        let bytes = serde_json::to_vec(&usage).unwrap();
        assert_eq!(serde_json::from_slice::<Usage>(&bytes).unwrap(), usage);
        assert!(!String::from_utf8(bytes).unwrap().contains("not-for-ipc"));
    }
    #[test]
    fn windows_follow_duration_and_authoritative_reset_count() {
        let u = parse_usage(&json!({"rateLimits":{"primary":{"windowDurationMins":10080,"usedPercent":9,"resetsAt":42},"secondary":{"windowDurationMins":300,"usedPercent":101}},"rateLimitResetCredits":{"availableCount":7,"credits":[]}})).unwrap();
        assert_eq!(u.windows[0].id, "fiveHour");
        assert_eq!(u.windows[1].resets_at, Some(42000));
        assert_eq!(u.reset_tokens, Some(7));
    }
    #[test]
    fn missing_is_unknown_not_zero() {
        let u = parse_usage(&json!({"rateLimits":{"primary":{"usedPercent":0}}})).unwrap();
        assert!(u.windows.is_empty());
        assert_eq!(u.reset_tokens, None);
    }
    #[test]
    fn slot_paths_are_exact_allowlist() {
        for id in [
            "../codex-1",
            "codex-01",
            "codex-5",
            "codex-1/../codex-2",
            "C:\\x",
        ] {
            assert!(slot_index(id).is_err());
        }
        assert_eq!(slot_index("codex-4").unwrap(), 3);
    }
    #[test]
    fn email_is_not_identity_and_workspace_is_part_of_key() {
        let account =
            json!({"account":{"type":"chatgpt","email":"same@example.test","planType":"plus"}});
        assert!(identity_from_claims(&account, &json!({})).is_none());
        let claims = |p, w| json!({"https://api.openai.com/auth":{"chatgpt_user_id":p,"chatgpt_account_id":w}});
        let a = identity_from_claims(&account, &claims("user-a", "workspace-a")).unwrap();
        assert_ne!(
            a.key,
            identity_from_claims(&account, &claims("user-b", "workspace-a"))
                .unwrap()
                .key
        );
        assert_ne!(
            a.key,
            identity_from_claims(&account, &claims("user-a", "workspace-b"))
                .unwrap()
                .key
        );
        let routed =
            json!({"account":{"type":"chatgpt"},"workspaceRouting":{"chatgptAccountId":"other"}});
        assert!(identity_from_claims(&routed, &claims("user-a", "workspace-a")).is_none());
    }
    #[test]
    fn error_preserves_usage_but_replacement_never_does() {
        let mut a = initial_accounts().remove(0);
        a.identity = Some(Identity {
            key: "a".into(),
            email: None,
            workspace_id: None,
            plan: None,
        });
        a.usage = Some(Usage {
            windows: vec![],
            reset_tokens: Some(7),
            billing: None,
            reset_credits: None,
            reset_credits_error: None,
            reset_credits_next_check_at: None,
        });
        a.last_success_at = Some(10);
        mark_error(&mut a, 20, "Unavailable");
        assert_eq!(a.usage.as_ref().unwrap().reset_tokens, Some(7));
        assert_eq!(a.last_success_at, Some(10));
        apply_identity(&mut a, None);
        assert!(a.usage.is_none());
        assert!(a.last_success_at.is_none());
    }
    #[test]
    fn duplicates_use_composite_identity_not_email() {
        let mut a = initial_accounts();
        let id = Identity {
            key: "same-principal-and-workspace".into(),
            email: None,
            workspace_id: None,
            plan: None,
        };
        a[0].identity = Some(id.clone());
        a[1].identity = Some(id);
        a[0].status = AccountStatus::Connected;
        a[1].status = AccountStatus::Connected;
        mark_duplicates(&mut a);
        assert_eq!(a[1].duplicate_of.as_deref(), Some("codex-1"));
        assert_eq!(a[1].status, AccountStatus::Duplicate);
    }
}
