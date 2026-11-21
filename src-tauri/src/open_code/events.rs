//! Event stream reading for the local OpenCode V2 service.
//!
//! The V2 service exposes one long-lived `GET /api/event` stream. It sends
//! `data: {json}` lines with `: heartbeat` comments and no `event:` name, and
//! it never replays history. This module owns frame parsing, subscription
//! lifetime and bounded shutdown.
//!
//! Shutdown is bounded: the reader checks its stop token before every read and
//! the HTTP client applies [`super::client::READ_TIMEOUT`] to a stalled read.
//! There is no dedicated blocking thread; the reader is an async task that
//! returns as soon as it observes the stop token.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;

use super::client::ServiceSession;
use super::types::ConnectionState;
use super::Host;

/// One suspension primitive supplied by the caller so this module needs no
/// timer dependency of its own.
pub type Pause = Arc<dyn Fn(u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Guard against a peer that never sends a line break.
const MAX_BUFFER_BYTES: usize = 1024 * 1024;

enum ReadOutcome {
    Cancelled,
    Ended { received: bool },
}

/// Run the subscription loop until the caller stops it.
///
/// The loop reconnects with bounded backoff while a subscription is active, so
/// a service restart or a dropped socket recovers without user action.
pub async fn run(host: Arc<Host>, pause: Pause) {
    let Some(token) = host.claim_stream_token() else {
        return;
    };
    let mut attempt: u32 = 0;
    loop {
        if token.load(Ordering::SeqCst) {
            host.finish_stream(&token);
            return;
        }
        match host.discover().await {
            Ok(_) => {}
            Err(error) => {
                host.mark_stream_degraded(error.message);
                attempt = attempt.saturating_add(1);
                pause(backoff_millis(attempt)).await;
                continue;
            }
        }
        match host.ensure_connection().await {
            Ok(session) => {
                host.reverify_owned(token.as_ref()).await;
                match read_stream(&host, &session, &token).await {
                    ReadOutcome::Cancelled => {
                        host.finish_stream(&token);
                        return;
                    }
                    ReadOutcome::Ended { received } => {
                        if received {
                            attempt = 0;
                        }
                        host.mark_stream_degraded("OpenCode event stream closed");
                    }
                }
            }
            Err(error) => host.mark_stream_degraded(error.message.clone()),
        }
        if token.load(Ordering::SeqCst) {
            host.finish_stream(&token);
            return;
        }
        attempt = attempt.saturating_add(1);
        pause(backoff_millis(attempt)).await;
    }
}

fn backoff_millis(attempt: u32) -> u64 {
    let shift = attempt.min(4);
    500u64 << shift
}

async fn read_stream(
    host: &Host,
    session: &ServiceSession,
    token: &Arc<AtomicBool>,
) -> ReadOutcome {
    let request = match session.stream_request(host.http()) {
        Ok(request) => request,
        Err(error) => {
            host.mark_stream_degraded(error.message);
            return ReadOutcome::Ended { received: false };
        }
    };
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_connect() {
                "OpenCode event stream is not reachable".to_string()
            } else if error.is_timeout() {
                "OpenCode event stream timed out".to_string()
            } else {
                "OpenCode event stream failed".to_string()
            };
            host.mark_stream_degraded(message);
            return ReadOutcome::Ended { received: false };
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // The service may have restarted with a new password. Drop the cached
        // connection so the next attempt rediscovers the registration file.
        host.invalidate_connection(ConnectionState::Unauthorized);
        return ReadOutcome::Ended { received: false };
    }
    if !status.is_success() {
        host.mark_stream_degraded("OpenCode event stream was rejected");
        return ReadOutcome::Ended { received: false };
    }
    host.mark_stream_connected();

    let mut bytes = Vec::new();
    let mut received = false;
    loop {
        if token.load(Ordering::SeqCst) {
            return ReadOutcome::Cancelled;
        }
        match response.chunk().await {
            Ok(Some(chunk)) => {
                received = true;
                bytes.extend_from_slice(&chunk);
                if bytes.len() > MAX_BUFFER_BYTES {
                    // A peer that never terminates a line is treated as broken.
                    host.mark_stream_degraded("OpenCode event stream sent an oversized frame");
                    return ReadOutcome::Ended { received };
                }
                // Decode complete lines only: a chunk can split UTF-8 bytes.
                if let Some(end) = bytes.iter().rposition(|byte| *byte == b'\n') {
                    let mut buffer = String::from_utf8_lossy(&bytes[..=end]).into_owned();
                    bytes.drain(..=end);
                    for record in parse_records(&mut buffer) {
                        host.handle_stream_record(record);
                    }
                }
            }
            Ok(None) => return ReadOutcome::Ended { received },
            Err(_) => return ReadOutcome::Ended { received },
        }
    }
}

/// Extract every complete record from `buffer`, leaving any partial tail.
///
/// Handles `data:` records with or without a trailing blank line, ignores
/// comments (`: heartbeat`) and unknown fields, and drops malformed JSON.
pub fn parse_records(buffer: &mut String) -> Vec<Value> {
    let mut records = Vec::new();
    let mut data = String::new();
    loop {
        let Some(index) = buffer.find('\n') else {
            break;
        };
        let line = buffer[..index].trim_end_matches('\r').to_string();
        buffer.drain(..=index);
        if line.is_empty() {
            flush(&mut data, &mut records);
            continue;
        }
        let Some(rest) = line.strip_prefix("data:") else {
            // `: comment`, `event:`, `id:` and `retry:` carry no payload here.
            continue;
        };
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        if data.is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(rest) {
                records.push(value);
                continue;
            }
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(rest);
        // Some servers omit the separating blank line, so try to close the
        // record after each appended line.
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            records.push(value);
            data.clear();
        }
    }
    records
}

fn flush(data: &mut String, records: &mut Vec<Value>) {
    if data.trim().is_empty() {
        data.clear();
        return;
    }
    if let Ok(value) = serde_json::from_str::<Value>(data) {
        records.push(value);
    }
    data.clear();
}

/// Pause implementation for tests: reconnect attempts continue immediately.
pub fn immediate_pause() -> Pause {
    Arc::new(|_| Box::pin(async {}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_named_data_records() {
        let mut buffer = String::from(
            ": heartbeat\n\ndata: {\"type\":\"server.connected\"}\n\ndata: {\"type\":\"session.status\"}\n\n",
        );
        let records = parse_records(&mut buffer);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["type"], json!("server.connected"));
        assert!(buffer.is_empty());
    }

    #[test]
    fn keeps_a_partial_record_for_the_next_chunk() {
        let mut buffer = String::from("data: {\"type\":\"session.tex");
        assert!(parse_records(&mut buffer).is_empty());
        buffer.push_str("t.delta\",\"delta\":\"hi\"}\n\n");
        let records = parse_records(&mut buffer);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["delta"], json!("hi"));
    }

    #[test]
    fn handles_adjacent_data_lines_without_blank_separator() {
        let mut buffer = String::from("data: {\"a\":1}\ndata: {\"a\":2}\ndata: {\"a\":3}\n");
        let records = parse_records(&mut buffer);
        assert_eq!(records.len(), 3);
        assert_eq!(records[2]["a"], json!(3));
    }

    #[test]
    fn handles_crlf_and_malformed_payloads() {
        let mut buffer = String::from("data: not-json\r\n\r\ndata: {\"ok\":true}\r\n\r\n");
        let records = parse_records(&mut buffer);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["ok"], json!(true));
    }

    #[test]
    fn ignores_comments_and_unknown_fields() {
        let mut buffer =
            String::from(": ping\nevent: message\nid: 4\nretry: 10\ndata: {\"x\":1}\n\n");
        let records = parse_records(&mut buffer);
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn backoff_is_bounded() {
        assert_eq!(backoff_millis(0), 500);
        assert_eq!(backoff_millis(1), 1000);
        assert_eq!(backoff_millis(2), 2000);
        assert_eq!(backoff_millis(3), 4000);
        assert_eq!(backoff_millis(9), 8000);
    }
}
