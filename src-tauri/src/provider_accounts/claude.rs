//! Isolated Claude subscription monitoring. No Desktop credentials or inference.
use super::model::{
    apply_identity, expiry_millis, mark_error, reset_count, AccountStatus, ProviderAccount,
    ResetCredit, ResetCredits, ResetCreditsError, ResetKind, Usage, UsageWindow,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_BODY: usize = 64 * 1024;
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const MIN_INTERVAL: Duration = Duration::from_secs(300);
const GRANTS_INTERVAL_MS: i64 = 60 * 60 * 1000;
const INELIGIBLE_INTERVAL_MS: i64 = 24 * GRANTS_INTERVAL_MS;

struct Session {
    identity: super::model::Identity,
    access_token: String,
    expires_at: i64,
}

fn read_json(path: &Path, limit: usize, error: &str) -> Result<Value, String> {
    super::storage::reject_link(path).map_err(|_| "unsafeStorage")?;
    let file = std::fs::File::open(path).map_err(|_| error.to_owned())?;
    if !file.metadata().map_err(|_| error.to_owned())?.is_file() {
        return Err("unsafeStorage".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error.to_owned())?;
    if bytes.len() > limit {
        return Err(error.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| error.into())
}

fn text(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)?
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.len() <= 256 && s.trim() == *s && !s.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

fn read_session(home: &Path) -> Result<Session, String> {
    super::external_cli::check_home(home)?;
    // The launcher explicitly sets CLAUDE_CONFIG_DIR to this exact slot directory.
    // Never search a default user home, Desktop store, environment or keychain.
    let config = home.join(".claude");
    let credentials = read_json(
        &config.join(".credentials.json"),
        MAX_BODY,
        "claudeAuthRequired",
    )?;
    let oauth = credentials
        .get("claudeAiOauth")
        .ok_or("claudeAuthRequired")?;
    let access_token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192 && s.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or("claudeAuthRequired")?
        .to_owned();
    let expires_at = oauth
        .get("expiresAt")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
        .ok_or("claudeAuthRequired")?;
    let scopes = oauth
        .get("scopes")
        .and_then(Value::as_array)
        .ok_or("unsupportedAuth")?;
    if !scopes.iter().any(|s| s.as_str() == Some("user:profile")) {
        return Err("unsupportedAuth".into());
    }
    let metadata = read_json(
        &config.join(".claude.json"),
        1024 * 1024,
        "claudeIdentityUnavailable",
    )?;
    let account = metadata
        .get("oauthAccount")
        .ok_or("claudeIdentityUnavailable")?;
    let principal = text(account, "accountUuid").ok_or("claudeIdentityUnavailable")?;
    let organization = text(account, "organizationUuid").ok_or("claudeIdentityUnavailable")?;
    let key = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&("claude", principal, &organization))
                .map_err(|_| "claudeIdentityUnavailable")?
        )
    );
    Ok(Session {
        access_token,
        expires_at,
        identity: super::model::Identity {
            key,
            email: text(account, "emailAddress"),
            workspace_id: Some(organization),
            plan: text(oauth, "subscriptionType"),
        },
    })
}

fn rfc3339_millis(value: &Value) -> Option<i64> {
    let text = value.as_str().filter(|s| s.len() <= 64)?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn parse_grants(block: &Value, now: i64) -> Result<ResetCredits, ResetCreditsError> {
    use ResetCreditsError::{Surface, Unavailable};
    let eligible = block
        .get("eligible")
        .and_then(Value::as_bool)
        .ok_or(Unavailable)?;
    if block.get("ineligible_reason").and_then(Value::as_str) == Some("surface") {
        return Err(Surface);
    }
    let grants = block
        .get("grants")
        .and_then(Value::as_array)
        .filter(|g| g.len() <= 256)
        .ok_or(Unavailable)?;
    // Account/surface eligibility and immediately redeemable are not inventory.
    // A saved grant may require reaching a limit before it can be redeemed.
    if !eligible && grants.is_empty() {
        return Err(Unavailable);
    }
    let mut count = 0i64;
    let mut credits = Vec::new();
    let mut details_complete = true;
    let mut seen = std::collections::HashSet::new();
    for grant in grants {
        if let Some(id) = grant.get("id").and_then(Value::as_str) {
            if id.len() > 256 || !seen.insert(id) {
                return Err(Unavailable);
            }
        }
        let left = grant
            .get("resets_left")
            .and_then(reset_count)
            .ok_or(Unavailable)?;
        if left == 0 || grant.get("paused").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(starts) = grant.get("starts_at").filter(|v| !v.is_null()) {
            let starts = rfc3339_millis(starts).ok_or(Unavailable)?;
            if starts > now {
                continue;
            }
        }
        let (expires_at, expiry_known) = expiry_millis(grant.get("ends_at"), rfc3339_millis);
        if expires_at.is_some_and(|end| end <= now) {
            continue;
        }
        let kind = if grant.get("gives_back_weekly").and_then(Value::as_bool) == Some(true) {
            ResetKind::Fable
        } else {
            match grant.get("type").and_then(Value::as_str) {
                Some("session") => ResetKind::Session,
                Some("weekly") => ResetKind::Weekly,
                Some("full") => ResetKind::Full,
                _ => {
                    let clears = grant.get("clears").and_then(Value::as_array);
                    let session =
                        clears.is_some_and(|c| c.iter().any(|v| v.as_str() == Some("five_hour")));
                    let weekly =
                        clears.is_some_and(|c| c.iter().any(|v| v.as_str() == Some("seven_day")));
                    match (session, weekly) {
                        (true, true) => ResetKind::Full,
                        (true, false) => ResetKind::Session,
                        (false, true) => ResetKind::Weekly,
                        _ => ResetKind::Unknown,
                    }
                }
            }
        };
        count = count
            .checked_add(left)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(Unavailable)?;
        details_complete &= expiry_known;
        credits.push(ResetCredit {
            kind,
            count: left,
            expires_at,
            expiry_known,
        });
    }
    Ok(ResetCredits {
        available_count: count,
        credits,
        details_complete,
        observed_at: now,
    })
}

fn parse_usage(bytes: &[u8]) -> Result<Usage, String> {
    if bytes.len() > MAX_BODY {
        return Err("claudeInvalidUsage".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "claudeInvalidUsage")?;
    if !value.is_object() || value.get("error").is_some_and(|e| !e.is_null()) {
        return Err("claudeInvalidUsage".into());
    }
    let mut windows = Vec::new();
    for (field, id, minutes) in [
        ("five_hour", "fiveHour", 300),
        ("seven_day", "weekly", 10080),
    ] {
        let Some(window) = value.get(field).filter(|w| !w.is_null()) else {
            continue;
        };
        if !window.is_object() {
            return Err("claudeInvalidUsage".into());
        }
        windows.push(UsageWindow {
            id: id.into(),
            window_minutes: minutes,
            used_percent: window
                .get("utilization")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && (0.0..=100.0).contains(n)),
            resets_at: window
                .get("resets_at")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 64)
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
                .filter(|n| *n >= 0),
        });
    }
    if let Some(limits) = value.get("limits").filter(|v| !v.is_null()) {
        let limits = limits
            .as_array()
            .filter(|v| v.len() <= 64)
            .ok_or("claudeInvalidUsage")?;
        let mut seen = std::collections::HashSet::new();
        for limit in limits {
            let (id, minutes) = match limit.get("kind").and_then(Value::as_str) {
                Some("session") if limit.get("scope").map_or(true, Value::is_null) => {
                    ("fiveHour", 300)
                }
                Some("weekly_all") if limit.get("scope").map_or(true, Value::is_null) => {
                    ("weekly", 10080)
                }
                Some("weekly_scoped")
                    if limit
                        .pointer("/scope/model/display_name")
                        .and_then(Value::as_str)
                        == Some("Fable") =>
                {
                    ("weeklyFable", 10080)
                }
                _ => continue,
            };
            if !seen.insert(id) {
                return Err("claudeInvalidUsage".into());
            }
            // Prefer the structured provider value; never derive a scoped limit
            // from the all-model percentage or a public plan ratio.
            windows.retain(|w| w.id != id);
            windows.push(UsageWindow {
                id: id.into(),
                window_minutes: minutes,
                used_percent: limit
                    .get("percent")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite() && (0.0..=100.0).contains(n)),
                resets_at: limit
                    .get("resets_at")
                    .and_then(Value::as_str)
                    .filter(|s| s.len() <= 64)
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp_millis())
                    .filter(|n| *n >= 0),
            });
        }
    }
    if value.get("five_hour").is_none()
        && value.get("seven_day").is_none()
        && value.get("limits").and_then(Value::as_array).is_none()
    {
        return Err("claudeInvalidUsage".into());
    }
    let now = super::now();
    let grants = value
        .get("cedar_ember")
        .map(|block| parse_grants(block, now));
    let next_check = grants.as_ref().map(|_| {
        now + if value
            .pointer("/cedar_ember/eligible")
            .and_then(Value::as_bool)
            == Some(false)
        {
            INELIGIBLE_INTERVAL_MS
        } else {
            GRANTS_INTERVAL_MS
        }
    });
    let reset_credits = grants.as_ref().and_then(|g| g.as_ref().ok()).cloned();
    Ok(Usage {
        windows,
        reset_tokens: reset_credits.as_ref().map(|r| r.available_count),
        billing: None,
        reset_credits,
        reset_credits_error: grants.and_then(Result::err),
        reset_credits_next_check_at: next_check,
    })
}

#[derive(Default)]
pub(super) struct Poll {
    identity_key: String,
    next_attempt: Option<Instant>,
    next_grants_at: i64,
    rate_failures: u8,
}

struct UsageClient {
    url: String,
}

struct Failure {
    code: &'static str,
    retry_after: Duration,
}

impl From<&'static str> for Failure {
    fn from(code: &'static str) -> Self {
        Self {
            code,
            retry_after: MIN_INTERVAL,
        }
    }
}

impl UsageClient {
    fn read(&self, token: &str, include_grants: bool) -> Result<Usage, Failure> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .user_agent(concat!(
                "TABS/",
                env!("CARGO_PKG_VERSION"),
                " quota-monitor"
            ))
            .build()
            .map_err(|_| Failure::from("claudeNetworkUnavailable"))?;
        let url = if include_grants {
            format!("{}?cedar_ember=1&skip_spend=1", self.url)
        } else {
            self.url.clone()
        };
        let mut response = client
            .get(url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .map_err(|_| Failure::from("claudeNetworkUnavailable"))?;
        match response.status().as_u16() {
            200 => {}
            401 => return Err("claudeAuthRequired".into()),
            403 => return Err("claudeAccessDenied".into()),
            429 => {
                let seconds = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| {
                        response
                            .headers()
                            .get(reqwest::header::RETRY_AFTER)
                            .and_then(|h| h.to_str().ok())
                            .filter(|s| s.len() <= 128)
                            .and_then(|s| chrono::DateTime::parse_from_rfc2822(s).ok())
                            .map(|d| ((d.timestamp_millis() - super::now()).max(0) / 1000) as u64)
                    })
                    .unwrap_or(300)
                    .clamp(300, 86400);
                return Err(Failure {
                    code: "claudeRateLimited",
                    retry_after: Duration::from_secs(seconds),
                });
            }
            _ => return Err("claudeInvalidUsage".into()),
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err("claudeInvalidUsage".into());
        }
        let mut bytes = Vec::new();
        (&mut response)
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::from("claudeNetworkUnavailable"))?;
        let mut usage = parse_usage(&bytes).map_err(|_| Failure::from("claudeInvalidUsage"))?;
        if include_grants && usage.reset_credits_next_check_at.is_none() {
            usage.reset_credits_error = Some(ResetCreditsError::Unavailable);
            usage.reset_credits_next_check_at = Some(super::now() + GRANTS_INTERVAL_MS);
        }
        Ok(usage)
    }
}

fn fail(account: &mut ProviderAccount, error: &str) {
    mark_error(account, super::now(), error);
    if error == "claudeAuthRequired" {
        account.status = AccountStatus::AuthRequired;
    }
}

fn observe_with(home: &Path, account: &mut ProviderAccount, poll: &mut Poll, client: &UsageClient) {
    let session = match read_session(home) {
        Ok(session) => session,
        Err(error) => {
            apply_identity(account, None);
            fail(account, &error);
            return;
        }
    };
    apply_identity(account, Some(session.identity.clone()));
    if session.expires_at <= super::now() {
        fail(account, "claudeAuthRequired");
        return;
    }
    if poll.identity_key != session.identity.key {
        *poll = Poll {
            identity_key: session.identity.key.clone(),
            ..Poll::default()
        };
    }
    if poll.next_attempt.is_some_and(|next| Instant::now() < next) {
        return;
    }
    let previous = account.usage.as_ref();
    let grants_deadline = previous
        .and_then(|u| u.reset_credits_next_check_at)
        .unwrap_or(0)
        .max(poll.next_grants_at);
    // A saved 429 deadline covers both variants after reopening, too.
    if account.error.as_deref() == Some("claudeRateLimited") && grants_deadline > super::now() {
        return;
    }
    let include_grants = grants_deadline <= super::now();
    if include_grants {
        poll.next_grants_at = super::now() + GRANTS_INTERVAL_MS;
    }
    account.last_attempt_at = Some(super::now());
    // Set a deadline even when transport or parsing fails. Page/tray share this Poll
    // under the native store lock; manual refresh cannot create a request storm.
    poll.next_attempt = Some(Instant::now() + MIN_INTERVAL);
    let result = client.read(&session.access_token, include_grants);
    let unchanged = read_session(home).is_ok_and(|current| {
        current.access_token == session.access_token
            && current.identity == session.identity
            && current.expires_at == session.expires_at
    });
    if !unchanged {
        apply_identity(account, None);
        fail(account, "claudeIdentityUnavailable");
        return;
    }
    match result {
        Ok(mut usage) => {
            if usage.reset_credits.is_none() {
                if let Some(previous) = &account.usage {
                    usage.reset_credits = previous.reset_credits.clone();
                    usage.reset_tokens = previous.reset_tokens;
                    if !include_grants {
                        usage.reset_credits_error = previous.reset_credits_error.clone();
                        usage.reset_credits_next_check_at = previous.reset_credits_next_check_at;
                    }
                }
            }
            if let Some(next) = usage.reset_credits_next_check_at {
                poll.next_grants_at = next;
            }
            account.usage = Some(usage);
            account.last_success_at = Some(super::now());
            account.error = None;
            account.status = AccountStatus::Connected;
            poll.rate_failures = 0;
        }
        Err(error) => {
            let mut retry = GRANTS_INTERVAL_MS;
            if error.code == "claudeRateLimited" {
                poll.rate_failures = (poll.rate_failures + 1).min(7);
                let backoff = Duration::from_secs(300 * (1u64 << poll.rate_failures));
                poll.next_attempt = Some(Instant::now() + backoff.max(error.retry_after));
                retry = retry.max(backoff.max(error.retry_after).as_millis() as i64);
            }
            if include_grants || error.code == "claudeRateLimited" {
                poll.next_grants_at = super::now() + retry;
                if let Some(usage) = &mut account.usage {
                    usage.reset_credits_error = Some(ResetCreditsError::Unavailable);
                    usage.reset_credits_next_check_at = Some(poll.next_grants_at);
                }
            }
            fail(account, error.code);
        }
    }
}

pub(super) fn observe(home: &Path, account: &mut ProviderAccount, poll: &mut Poll) {
    observe_with(
        home,
        account,
        poll,
        &UsageClient {
            url: USAGE_URL.into(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banked_polling_survives_restart_keeps_last_good_and_shares_the_429_gate() {
        let dir = profile();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = UsageClient {
            url: format!("http://{}/api/oauth/usage", server.server_addr()),
        };
        let handle = std::thread::spawn(move || {
            for (query, status, body) in [
                (
                    "/api/oauth/usage?cedar_ember=1&skip_spend=1",
                    200,
                    r#"{"five_hour":{"utilization":20},"cedar_ember":{"eligible":true,"grants":[{"resets_left":2,"ends_at":null}]}}"#,
                ),
                (
                    "/api/oauth/usage",
                    200,
                    r#"{"five_hour":{"utilization":30}}"#,
                ),
                (
                    "/api/oauth/usage?cedar_ember=1&skip_spend=1",
                    429,
                    "withheld",
                ),
            ] {
                let request = server
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.method(), &tiny_http::Method::Get);
                assert_eq!(request.url(), query);
                assert!(request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("User-Agent") && h.value.as_str().starts_with("TABS/")));
                let _ = request.respond(
                    tiny_http::Response::from_string(body)
                        .with_status_code(status)
                        .with_header(tiny_http::Header::from_bytes("Retry-After", "3600").unwrap()),
                );
            }
            assert!(server
                .recv_timeout(Duration::from_millis(100))
                .unwrap()
                .is_none());
        });
        let mut account = account();
        let mut poll = Poll::default();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(account.usage.as_ref().unwrap().reset_tokens, Some(2));
        let observed = account
            .usage
            .as_ref()
            .unwrap()
            .reset_credits
            .as_ref()
            .unwrap()
            .observed_at;
        // Serialization + fresh polling state model a real reopened native store.
        account = serde_json::from_slice(&serde_json::to_vec(&account).unwrap()).unwrap();
        poll = Poll::default();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(
            account.usage.as_ref().unwrap().windows[0].used_percent,
            Some(30.0)
        );
        assert_eq!(account.usage.as_ref().unwrap().reset_tokens, Some(2));
        assert_eq!(
            account
                .usage
                .as_ref()
                .unwrap()
                .reset_credits
                .as_ref()
                .unwrap()
                .observed_at,
            observed
        );
        poll.next_attempt = None;
        poll.next_grants_at = 0;
        account.usage.as_mut().unwrap().reset_credits_next_check_at = Some(0);
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(account.error.as_deref(), Some("claudeRateLimited"));
        assert_eq!(account.usage.as_ref().unwrap().reset_tokens, Some(2));
        assert!(
            account
                .usage
                .as_ref()
                .unwrap()
                .reset_credits_next_check_at
                .unwrap()
                > super::super::now()
        );
        observe_with(dir.path(), &mut account, &mut poll, &client);
        poll = Poll::default();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        handle.join().unwrap();
    }

    #[test]
    fn banked_grants_sum_rights_not_rows_or_current_redemption_eligibility() {
        let usage = parse_usage(br#"{"five_hour":null,"cedar_ember":{"eligible":true,"grants":[
          {"id":"private-grant-a","resets_left":2,"ends_at":"2099-03-09T07:59:23.250+03:00","gives_back_weekly":true,"usable_now":false,"use_requires_limit":true},
          {"resets_left":1,"ends_at":null,"type":"session"},
          {"resets_left":0,"type":"weekly"},
          {"resets_left":8,"ends_at":"2020-01-01T00:00:00Z"},
          {"resets_left":4,"paused":true}
        ]}}"#).unwrap();
        let value = serde_json::to_value(usage).unwrap();
        assert_eq!(value["resetCredits"]["availableCount"], 3);
        assert_eq!(value["resetCredits"]["credits"][0]["kind"], "fable");
        assert_eq!(
            value["resetCredits"]["credits"][0]["expiresAt"],
            4076715563250i64
        );
        assert_eq!(value["resetCredits"]["credits"][1]["expiryKnown"], true);
        assert_eq!(value["resetCredits"]["detailsComplete"], true);
        assert!(!value.to_string().contains("private-grant"));
        let surface = serde_json::to_value(parse_usage(br#"{"five_hour":null,"cedar_ember":{"eligible":false,"ineligible_reason":"surface","grants":[]}}"#).unwrap()).unwrap();
        assert!(surface["resetCredits"].is_null());
        assert_eq!(surface["resetCreditsError"], "surface");
    }

    #[test]
    fn banked_invalid_or_missing_grants_are_unknown_and_explicit_empty_is_zero() {
        for block in [
            serde_json::json!({}),
            serde_json::json!({"eligible":true}),
            serde_json::json!({"eligible":true,"grants":[{"resets_left":-1}]}),
            serde_json::json!({"eligible":true,"grants":[{"resets_left":1.5}]}),
            serde_json::json!({"eligible":true,"grants":[{"resets_left":1,"starts_at":"invalid"}]}),
            serde_json::json!({"eligible":true,"grants":[{"id":"a","resets_left":1},{"id":"a","resets_left":1}]}),
            serde_json::json!({"eligible":false,"grants":[]}),
        ] {
            assert_eq!(
                parse_grants(&block, 1000),
                Err(ResetCreditsError::Unavailable)
            );
        }
        let zero = parse_grants(&serde_json::json!({"eligible":true,"grants":[]}), 1000).unwrap();
        assert_eq!(zero.available_count, 0);
        assert!(zero.details_complete);
        let unknown_expiry = parse_grants(&serde_json::json!({"eligible":true,"grants":[{"resets_left":2,"ends_at":"2026-02-30T00:00:00Z"}]}), 1000).unwrap();
        assert_eq!(unknown_expiry.available_count, 2);
        assert!(!unknown_expiry.details_complete);
        assert!(!unknown_expiry.credits[0].expiry_known);
        assert_eq!(unknown_expiry.credits[0].kind, ResetKind::Unknown);
    }

    #[test]
    fn banked_surface_failure_preserves_inventory_not_a_fabricated_zero_then_recovers() {
        let dir = profile();
        let mut account = account();
        let mut poll = Poll::default();
        for (body, force_due, count, error) in [
            (
                r#"{"five_hour":{"utilization":10},"cedar_ember":{"eligible":true,"grants":[{"resets_left":2,"ends_at":null}]}}"#,
                true,
                2,
                None,
            ),
            (
                r#"{"five_hour":{"utilization":20},"cedar_ember":{"eligible":false,"ineligible_reason":"surface","grants":[]}}"#,
                true,
                2,
                Some(ResetCreditsError::Surface),
            ),
            (
                r#"{"five_hour":{"utilization":30}}"#,
                false,
                2,
                Some(ResetCreditsError::Surface),
            ),
            (
                r#"{"five_hour":{"utilization":40},"cedar_ember":{"eligible":true,"grants":[]}}"#,
                true,
                0,
                None,
            ),
        ] {
            poll.next_attempt = None;
            if force_due {
                poll.next_grants_at = 0;
                if let Some(usage) = &mut account.usage {
                    usage.reset_credits_next_check_at = Some(0);
                }
            }
            let (client, handle) = server(200, body);
            observe_with(dir.path(), &mut account, &mut poll, &client);
            handle.join().unwrap();
            assert_eq!(account.status, AccountStatus::Connected);
            let usage = account.usage.as_ref().unwrap();
            assert_eq!(usage.reset_tokens, Some(count));
            assert_eq!(usage.reset_credits_error, error);
            assert!(usage.reset_credits_next_check_at.unwrap() > super::super::now());
            if error == Some(ResetCreditsError::Surface) {
                assert!(
                    usage.reset_credits_next_check_at.unwrap()
                        >= super::super::now() + INELIGIBLE_INTERVAL_MS - 1000
                );
            }
        }
    }

    #[test]
    fn fable_structured_duplicates_are_rejected_and_missing_values_stay_unknown() {
        assert!(parse_usage(br#"{"limits":[{"kind":"weekly_scoped","percent":10,"scope":{"model":{"display_name":"Fable"}}},{"kind":"weekly_scoped","percent":20,"scope":{"model":{"display_name":"Fable"}}}]}"#).is_err());
        let partial = parse_usage(br#"{"limits":[{"kind":"weekly_scoped","percent":101,"resets_at":"bad","scope":{"model":{"display_name":"Fable"}}},{"kind":"weekly_scoped","percent":30,"scope":{"model":{"display_name":"Other"}}}]}"#).unwrap();
        assert_eq!(partial.windows.len(), 1);
        assert_eq!(partial.windows[0].id, "weeklyFable");
        assert!(
            partial.windows[0].used_percent.is_none() && partial.windows[0].resets_at.is_none()
        );
    }

    #[test]
    fn fable_weekly_is_separate_from_all_models_and_uses_only_its_own_reset() {
        let usage = parse_usage(br#"{"seven_day":{"utilization":20,"resets_at":"2026-11-20T00:00:00Z"},"limits":[{"kind":"weekly_scoped","percent":45,"resets_at":"2026-11-21T00:00:00Z","scope":{"model":{"display_name":"Fable"}},"is_active":true}]}"#).unwrap();
        let fable = usage
            .windows
            .iter()
            .find(|w| w.id == "weeklyFable")
            .expect("Fable quota is missing");
        assert_eq!(fable.used_percent, Some(45.0));
        assert_ne!(
            fable.resets_at,
            usage
                .windows
                .iter()
                .find(|w| w.id == "weekly")
                .unwrap()
                .resets_at
        );
        let modern = parse_usage(br#"{"limits":[{"kind":"session","percent":12,"scope":null},{"kind":"weekly_all","percent":20},{"kind":"weekly_scoped","percent":0,"resets_at":null,"scope":{"model":{"display_name":"Fable"}}}]}"#).unwrap();
        assert_eq!(modern.windows.len(), 3);
        assert_eq!(
            modern
                .windows
                .iter()
                .find(|w| w.id == "weeklyFable")
                .unwrap()
                .used_percent,
            Some(0.0)
        );
    }

    #[test]
    #[ignore = "explicit read-only acceptance against the owner-approved TABS Claude slot; no snapshots or auth writes"]
    fn selected_tabs_slot_read_only_usage_smoke() {
        let expected =
            std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA required"))
                .join("com.tabs.app/provider-accounts/claude/claude-1");
        let selected = std::path::PathBuf::from(
            std::env::var_os("TABS_CLAUDE_MONITOR_HOME")
                .expect("explicit selected TABS slot required"),
        );
        assert_eq!(
            selected.canonicalize().unwrap(),
            expected.canonicalize().unwrap()
        );
        let mut account = account();
        observe(&selected, &mut account, &mut Poll::default());
        assert_eq!(
            account.status,
            AccountStatus::Connected,
            "sanitized failure: {:?}",
            account.error
        );
        assert!(account
            .usage
            .as_ref()
            .is_some_and(|usage| !usage.windows.is_empty()));
        assert!(account.last_success_at.is_some());
        // Nothing is written: this test does not construct a Store or start the CLI.
    }

    fn profile() -> tempfile::TempDir {
        let dir = tempfile::Builder::new()
            .prefix("tabs-claude-http-")
            .tempdir_in(super::super::storage::test_temp_root())
            .unwrap();
        let config = dir.path().join(".claude");
        std::fs::create_dir(&config).unwrap();
        std::fs::write(config.join(".credentials.json"), br#"{"claudeAiOauth":{"accessToken":"synthetic-unusable-token","expiresAt":9999999999999,"scopes":["user:profile"],"subscriptionType":"max"}}"#).unwrap();
        std::fs::write(config.join(".claude.json"), br#"{"oauthAccount":{"accountUuid":"fixture-account-a","organizationUuid":"fixture-org","emailAddress":"fixture@example.invalid"}}"#).unwrap();
        dir
    }

    fn account() -> super::super::model::ProviderAccount {
        let mut account = super::super::model::initial_accounts().remove(0);
        account.id = "claude-1".into();
        account.provider_id = "claude".into();
        account.label = "Claude 1".into();
        account.status = super::super::model::AccountStatus::Configured;
        account
    }

    fn server(status: u16, body: &str) -> (UsageClient, std::thread::JoinHandle<()>) {
        server_with_action(status, body, || {})
    }

    fn server_with_action(
        status: u16,
        body: &str,
        action: impl FnOnce() + Send + 'static,
    ) -> (UsageClient, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/oauth/usage", server.server_addr());
        let body = body.to_owned();
        let handle =
            std::thread::spawn(move || {
                let request = server
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                assert_eq!(request.method(), &tiny_http::Method::Get);
                assert!(matches!(
                    request.url(),
                    "/api/oauth/usage" | "/api/oauth/usage?cedar_ember=1&skip_spend=1"
                ));
                assert!(request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("Authorization")
                        && h.value.as_str() == "Bearer synthetic-unusable-token"));
                assert!(request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("anthropic-beta")
                        && h.value.as_str() == "oauth-2025-04-20"));
                action();
                let response = tiny_http::Response::from_string(body)
                    .with_status_code(status)
                    .with_header(tiny_http::Header::from_bytes("Retry-After", "900").unwrap());
                let _ = request.respond(response);
            });
        (UsageClient { url }, handle)
    }

    #[test]
    fn publishes_quota_for_this_oauth_profile_and_coalesces_page_and_tray_refresh() {
        let dir = profile();
        let mut account = account();
        let mut poll = Poll::default();
        let (client, handle) = server(
            200,
            r#"{"five_hour":{"utilization":25,"resets_at":"2026-11-14T03:00:00Z"},"seven_day":null}"#,
        );
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(
            account.status,
            super::super::model::AccountStatus::Connected
        );
        handle.join().unwrap();
        assert_eq!(
            account.usage.as_ref().unwrap().windows[0].used_percent,
            Some(25.0)
        );
        let before = account.clone();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(account, before);
    }

    #[test]
    fn reads_only_the_selected_profile_and_keeps_credentials_out_of_identity() {
        let dir = tempfile::Builder::new()
            .prefix("tabs-claude-test-")
            .tempdir_in(super::super::storage::test_temp_root())
            .unwrap();
        let config = dir.path().join(".claude");
        std::fs::create_dir(&config).unwrap();
        std::fs::write(config.join(".credentials.json"), br#"{"claudeAiOauth":{"accessToken":"synthetic-unusable-token","refreshToken":"synthetic-never-read","expiresAt":9999999999999,"scopes":["user:profile","user:inference"],"subscriptionType":"max"}}"#).unwrap();
        std::fs::write(config.join(".claude.json"), br#"{"oauthAccount":{"accountUuid":"fixture-account-a","organizationUuid":"fixture-org","emailAddress":"fixture@example.invalid"}}"#).unwrap();
        let session = read_session(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            session.identity.email.as_deref(),
            Some("fixture@example.invalid")
        );
        assert_eq!(
            session.identity.workspace_id.as_deref(),
            Some("fixture-org")
        );
        assert!(!session.identity.key.is_empty());
        let serialized = serde_json::to_string(&session.identity).unwrap();
        assert!(!serialized.contains("synthetic-"));
        std::fs::remove_file(config.join(".credentials.json")).unwrap();
        // A sibling/root credential is never a fallback for the selected config.
        std::fs::write(
            dir.path().join(".credentials.json"),
            br#"{"accessToken":"synthetic-other"}"#,
        )
        .unwrap();
        assert_eq!(
            read_session(dir.path()).err().as_deref(),
            Some("claudeAuthRequired")
        );
    }

    #[test]
    fn missing_and_invalid_values_stay_unknown_without_fabricated_refills() {
        for bytes in [
            b"{}".as_slice(),
            b"[]",
            b"not-json",
            br#"{"five_hour":42}"#,
            br#"{"error":"synthetic-sensitive-body","five_hour":null}"#,
        ] {
            assert_eq!(parse_usage(bytes).unwrap_err(), "claudeInvalidUsage");
        }
        assert!(parse_usage(&vec![b' '; MAX_BODY + 1]).is_err());
        let usage = parse_usage(br#"{"five_hour":{"utilization":101,"resets_at":"2026-02-30T00:00:00Z"},"seven_day":null}"#).unwrap();
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].used_percent, None);
        assert_eq!(usage.windows[0].resets_at, None);
        let zero = parse_usage(br#"{"five_hour":{"utilization":0,"resets_at":null}}"#).unwrap();
        assert_eq!(zero.windows[0].used_percent, Some(0.0));
        assert!(parse_usage(br#"{"five_hour":null,"seven_day":null}"#)
            .unwrap()
            .windows
            .is_empty());
    }

    #[test]
    fn failed_http_keeps_last_good_for_the_same_identity_and_backs_off() {
        for (status, body, error) in [
            (401, "synthetic-sensitive-body", "claudeAuthRequired"),
            (403, "synthetic-sensitive-body", "claudeAccessDenied"),
            (429, "synthetic-sensitive-body", "claudeRateLimited"),
            (503, "synthetic-sensitive-body", "claudeInvalidUsage"),
            (200, "synthetic-sensitive-body", "claudeInvalidUsage"),
        ] {
            let dir = profile();
            let mut account = account();
            account.identity = Some(
                read_session(dir.path())
                    .unwrap_or_else(|e| panic!("{e}"))
                    .identity,
            );
            account.usage = Some(parse_usage(br#"{"five_hour":{"utilization":30}}"#).unwrap());
            account.last_success_at = Some(123);
            let old_usage = account.usage.clone();
            let mut poll = Poll::default();
            let (client, handle) = server(status, body);
            observe_with(dir.path(), &mut account, &mut poll, &client);
            handle.join().unwrap();
            assert_eq!(account.error.as_deref(), Some(error));
            assert_eq!(account.last_success_at, Some(123));
            let mut expected = old_usage.unwrap();
            expected.reset_credits_error = Some(ResetCreditsError::Unavailable);
            expected.reset_credits_next_check_at =
                account.usage.as_ref().unwrap().reset_credits_next_check_at;
            assert!(expected.reset_credits_next_check_at.unwrap() > super::super::now());
            assert_eq!(account.usage.as_ref(), Some(&expected));
            assert_eq!(
                account.status,
                if status == 401 {
                    AccountStatus::AuthRequired
                } else {
                    AccountStatus::Error
                }
            );
            if status == 429 {
                assert!(
                    poll.next_attempt
                        .unwrap()
                        .saturating_duration_since(Instant::now())
                        >= Duration::from_secs(899)
                );
            }
            let previous = account.clone();
            observe_with(dir.path(), &mut account, &mut poll, &client);
            assert_eq!(account, previous);
            assert!(!serde_json::to_string(&account)
                .unwrap()
                .contains("synthetic-"));
        }
    }

    #[test]
    fn expiry_never_uses_http_or_rotates_tokens_and_missing_auth_clears_usage() {
        let dir = profile();
        let path = dir.path().join(".claude/.credentials.json");
        let mut credentials: Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        credentials["claudeAiOauth"]["expiresAt"] = 1.into();
        let original = serde_json::to_vec(&credentials).unwrap();
        std::fs::write(&path, &original).unwrap();
        let mut account = account();
        account.identity = Some(
            read_session(dir.path())
                .unwrap_or_else(|e| panic!("{e}"))
                .identity,
        );
        account.usage = Some(parse_usage(br#"{"five_hour":{"utilization":100}}"#).unwrap());
        account.last_success_at = Some(123);
        let client = UsageClient {
            url: "http://127.0.0.1:1/never-called".into(),
        };
        let mut poll = Poll::default();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert_eq!(account.status, AccountStatus::AuthRequired);
        assert_eq!(account.last_success_at, Some(123));
        assert!(account.usage.is_some());
        assert!(poll.next_attempt.is_none());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(path).unwrap();
        observe_with(dir.path(), &mut account, &mut poll, &client);
        assert!(account.identity.is_none() && account.usage.is_none());
        assert_eq!(account.last_success_at, None);
    }

    #[test]
    fn rejects_changed_identity_or_token_while_the_request_is_in_flight() {
        for change_token in [false, true] {
            let dir = profile();
            let config = dir.path().join(".claude");
            let (client, handle) = server_with_action(
                200,
                r#"{"five_hour":{"utilization":25}}"#,
                move || {
                    if change_token {
                        let path = config.join(".credentials.json");
                        let mut credentials: Value =
                            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                        credentials["claudeAiOauth"]["accessToken"] =
                            "synthetic-replacement".into();
                        std::fs::write(path, serde_json::to_vec(&credentials).unwrap()).unwrap();
                    } else {
                        std::fs::write(config.join(".claude.json"), br#"{"oauthAccount":{"accountUuid":"fixture-replacement","organizationUuid":"fixture-org"}}"#).unwrap();
                    }
                },
            );
            let mut account = account();
            observe_with(dir.path(), &mut account, &mut Poll::default(), &client);
            handle.join().unwrap();
            assert!(account.identity.is_none() && account.usage.is_none());
            assert_eq!(account.error.as_deref(), Some("claudeIdentityUnavailable"));
        }
    }

    #[test]
    fn redirects_are_not_followed_and_oversized_http_is_rejected() {
        let target = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let destination = format!("http://{}/must-not-receive-token", target.server_addr());
        let origin = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let client = UsageClient {
            url: format!("http://{}/api/oauth/usage", origin.server_addr()),
        };
        let handle =
            std::thread::spawn(move || {
                let request = origin
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
                    .unwrap();
                request
                    .respond(tiny_http::Response::empty(302).with_header(
                        tiny_http::Header::from_bytes("Location", destination).unwrap(),
                    ))
                    .unwrap();
            });
        assert_eq!(
            client
                .read("synthetic-unusable-token", false)
                .err()
                .unwrap()
                .code,
            "claudeInvalidUsage"
        );
        handle.join().unwrap();
        assert!(target.try_recv().unwrap().is_none());
        let (client, handle) = server(200, &" ".repeat(MAX_BODY + 1));
        assert_eq!(
            client
                .read("synthetic-unusable-token", false)
                .err()
                .unwrap()
                .code,
            "claudeInvalidUsage"
        );
        handle.join().unwrap();
    }

    #[test]
    fn rejects_api_key_only_profiles_missing_identity_and_oversized_credentials() {
        let dir = profile();
        let config = dir.path().join(".claude");
        for bytes in [
            br#"{"apiKey":"synthetic-only"}"#.as_slice(),
            b"broken",
            br#"{"claudeAiOauth":{"accessToken":"bad\nheader","expiresAt":9}}"#,
        ] {
            std::fs::write(config.join(".credentials.json"), bytes).unwrap();
            assert!(read_session(dir.path()).is_err());
        }
        std::fs::write(config.join(".credentials.json"), vec![b' '; MAX_BODY + 1]).unwrap();
        assert!(read_session(dir.path()).is_err());
        let healthy = profile();
        std::fs::write(healthy.path().join(".claude/.claude.json"), b"{}").unwrap();
        assert_eq!(
            read_session(healthy.path()).err().as_deref(),
            Some("claudeIdentityUnavailable")
        );
    }

    #[test]
    #[cfg(windows)]
    fn refuses_an_external_profile_junction_before_reading_credentials() {
        let outside = profile();
        let home = tempfile::Builder::new()
            .prefix("tabs-claude-link-")
            .tempdir_in(super::super::storage::test_temp_root())
            .unwrap();
        let link = home.path().join(".claude");
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(
                outside
                    .path()
                    .join(".claude")
                    .to_string_lossy()
                    .replace('/', "\\"),
            )
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let result = read_session(home.path()).err();
        // Remove only the synthetic junction, not its target, before fixture cleanup.
        std::fs::remove_dir(link).unwrap();
        assert_eq!(result.as_deref(), Some("unsafeStorage"));
    }

    #[test]
    fn parses_reported_windows_and_rfc3339_resets_without_estimating_tokens() {
        let usage = parse_usage(br#"{"five_hour":{"utilization":23.5,"resets_at":"2026-11-14T03:00:00.250+03:00"},"seven_day":{"utilization":41,"resets_at":"2026-11-20T00:00:00Z"},"extra_usage":{"utilization":80}}"#).unwrap();
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].window_minutes, 300);
        assert_eq!(usage.windows[0].used_percent, Some(23.5));
        assert_eq!(usage.windows[0].resets_at, Some(1794614400250));
        assert_eq!(usage.windows[1].window_minutes, 10080);
        assert_eq!(usage.windows[1].used_percent, Some(41.0));
        assert_eq!(usage.reset_tokens, None);
        assert_eq!(usage.billing, None);
    }
}
