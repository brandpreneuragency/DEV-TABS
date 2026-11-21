# Provider account backend

`inception.rs` owns the exact `inception-1` API-key monitor. Only the main window
can submit a key through `provider_accounts_connect_api_key`; saved keys never
leave native keyring storage. The only vendor request is a bounded, non-redirecting
read-only `GET https://api.inceptionlabs.ai/v1/models`, not inference or a quota
probe. Keys have a dedicated application-data-root-scoped keyring entry; no
existing provider/login storage or capability scope is changed. The Billing
opener accepts only the exact account ID and a fixed official destination.

Published limits and the one-time starting token grant are frontend reference
data, not observed usage. Inception snapshots keep identity and usage null because
the documented API provides neither account attribution nor an account balance.
Real owner-key acceptance and installed-app delivery require separate scope.

The existing isolated Codex implementation below is retained. `external.rs`
dispatches exact `claude-1`, `grok-1` and `commandcode-1` slots to separate
provider-owned profiles/snapshots. `external_cli.rs` owns fixed native CLI
commands and login-console lifecycle; `grok.rs` owns the read-only Grok ACP
account/billing protocol. No chat adapter, existing application credential or
owner-default CLI home is selected by these monitoring operations.

CommandCode status is configured-only evidence, not a live quota check.
Claude now uses the explicitly owner-approved undocumented OAuth usage endpoint
through `claude.rs`. It reads only `.claude/.credentials.json` and
`.claude/.claude.json` under the native `claude-1` home. No Desktop/default-home
credential search, refresh-token write, inference or browser-cookie access exists.
The monitor publishes only sanitized identity, five-hour/weekly windows and fixed
error codes. It never returns token material to IPC, snapshots or logs.

Claude's structured `limits[]` also supplies the separate `weeklyFable` window;
it never substitutes for the all-model week. Banked reset inventory uses the
same read-only endpoint with `?cedar_ember=1&skip_spend=1` on the first due poll,
at most hourly when eligible/unknown, daily when explicitly ineligible. A due
grant poll replaces the ordinary usage request instead of adding another request.
Both variants share the five-minute gate and HTTP 429 cooldown. Grant deadlines
are retained in sanitized usage snapshots, including failed checks when there is
a preceding usage snapshot; cold failures without a snapshot have an in-memory
deadline only. Plain usage refreshes retain inventory and its own observation time.
No CLI User-Agent impersonation is used; `surface` denial remains unknown, not zero.

`resets_left` is a count, not a number of grant rows. Spent, expired, paused and
not-yet-started grants are excluded at observation. `usable_now`/`next_grant_id`
do not erase saved rights merely because redemption requires reaching a limit.
`gives_back_weekly` identifies a Fable reset, not a full weekly reset. Kind, count,
validated expiry and observation time are the only grant details published;
redemption IDs, provider descriptions and raw payloads are never persisted/exported.

Codex keeps `rateLimitResetCredits.availableCount` authoritative while sanitizing
up to 256 available credit details and converting Unix seconds to milliseconds.
Missing/capped/malformed details do not replace that count. Explicit null expiry
is different from missing/invalid expiry. New fields are optional when reading
existing snapshots; no credential/data migration is required. Older binaries
with `deny_unknown_fields` cannot read snapshots after new fields are saved:
an executable-only downgrade is not a supported rollback procedure.

Requests go only to `GET https://api.anthropic.com/api/oauth/usage`, with redirects
and proxy inheritance disabled, 5-second connect/15-second total deadlines and
a 64 KiB response limit. The account store serializes page/tray requests and
applies a five-minute minimum interval, with extended backoff on HTTP 429.
Expired/rejected access requires explicit sign-in again; TABS does not rotate
tokens or generate a model message to trigger refresh. The endpoint and local
vendor schema are unsupported contracts and can change. Identity metadata is
local attribution, not remote principal verification. A changed/missing identity
or a credential change during a request withholds the result.

`provider_accounts_open_usage` accepts an account ID, not a URL, and opens only
the fixed official Claude/CommandCode destination through the OS. A browser's
current login may differ from the CLI slot. No shell/HTTP permission is added.

Snapshot validation is parameterized by a native provider allowlist. Codex still
loads/saves exactly four rows at its original path, with the same serialized
fields when the optional Grok billing field is absent. External snapshots live
under their own provider directory; corruption is never auto-repaired. No
credential migration or new dependency is part of the provider extension.

External interactive login requires the console-less Windows release host
(`src/main.rs` Windows subsystem). A redirected/console-attached debug host is
refused before spawning an unusable login console. This is deliberate; there is
no shell fallback or global console-handle mutation. A synthetic GUI host has
verified a new visible console with readable stdin/stdout/stderr; actual owner
OAuth and installed-app acceptance remain separate.

## Existing isolated Codex backend

This module owns monitoring/login only. It never starts a thread/turn, redeems a
reset credit, selects an AI Chat account, reads the native Codex home, or imports
another application's credentials.

## Tauri integration

1. Add `mod provider_accounts;` in `src-tauri/src/lib.rs`.
2. Change only the visibility of `codex::discovery` to `pub(crate) mod discovery;`.
   The existing `codex::CliOwnedJob` re-export already provides process ownership.
   **Do not change the chat-specific supported-version pin.** This module uses
   the discovered native launch regardless of `Discovery.supported` and performs
   its own initialize/account handshake.
3. Register these commands in the existing Tauri invoke handler:
   - `provider_accounts::provider_accounts_list`
   - `provider_accounts::provider_accounts_refresh`
   - `provider_accounts::provider_accounts_begin_login`
   - `provider_accounts::provider_accounts_poll_login`
   - `provider_accounts::provider_accounts_cancel_login`
   - `provider_accounts::provider_accounts_open_login`
4. No `.manage(...)` state registration, new dependency or broad shell/opener
   permission is required. The process-local registry is keyed by canonical app
   data path. All commands are async and move blocking work off the UI thread.

Arguments are `accountId` and `loginId` on the JavaScript boundary; refresh's
`accountId` is nullable. Struct fields serialize camelCase. Times are epoch
milliseconds. Every command also takes the injected WebviewWindow and rejects
windows other than `main`. Login URL is returned only by `begin_login`, validated
against the exact HTTPS `auth.openai.com` authority, never persisted or logged.
The opener accepts only the active account/login IDs and retrieves their cached
URL; it never accepts a renderer-supplied URL. Windows ShellExecuteW opens that
URL directly without a shell command. Only its existing windows-sys compile
features are enabled; no Tauri shell/file permission is broadened. UI code must
not log the authorization URL.

`poll_login.status=completed` means authentication completed. A quota read can
still fail: inspect the returned account's `status`/`error`. `pending` has a null
account. Terminal results are repeatable until a new login replaces that slot.
Old login IDs never cancel, poll or publish into the replacement login. Manual
refresh skips a slot with a pending unexpired login. A ten-minute watchdog kills
abandoned login processes even when the frontend stops polling. RPCs have finite
twenty-second deadlines; process trees use kill-on-close Windows Job Objects.
The supported browser flow owns a local callback listener, so different account
slots are linked sequentially. Starting another slot's login while one is pending
is refused before changing that slot's metadata. Replacing the same slot still
invalidates its old login ID and old quota.

## Local state and identity

- Sanitized snapshots: `<app_data_dir>/provider-accounts/codex/accounts.json`.
- Isolated homes: `<app_data_dir>/provider-accounts/codex/codex-1` through
  `codex-4`, selected by exact slot allowlist, never a frontend-supplied path.
- Snapshot writes are serialized, staged, synced, atomically replaced, and refuse
  to overwrite parse corruption. Symlinks/reparse points are rejected.
- Child environment is allowlisted and home/config/temp directories are private
  to that slot. No inherited API keys, proxy overrides or provider settings.
- Auth uses Codex's `cli_auth_credentials_store="keyring"`, forced ChatGPT login,
  and `features.secret_auth_storage=true`. Codex encrypts the auth payload in the
  slot's `secrets/codex_auth.age`; only its short encryption passphrase is stored
  in the OS keyring. This avoids the Windows 2560-character credential limit.
  No `auto`/`file` storage, plaintext fallback or native/default home is allowed.
- Identity reads **only** the exact slot's encrypted Codex auth, using the official
  0.159.2 format in `codex-rs/secrets/src/{lib,local}.rs`: keyring service `codex`,
  account `secrets|` + first 16 SHA256 hex characters of canonical `CODEX_HOME`,
  age/scrypt envelope, version 0/1 JSON and `secrets["global/CODEX_AUTH"]`.
  Ciphertext/plaintext reads and scrypt cost are bounded; reparse points,
  corruption, missing keys and unsupported formats fail closed without repair.
  TABS never writes credentials or creates/replaces an encryption key.
- Prior direct-keyring entries are preserved, not imported or used as fallback;
  any previously linked slot needs a fresh login with this backend. A failed
  `persist_failed` login must also be retried after the corrected build is active.
- Principal/workspace metadata comes from the decrypted ID-token claims, checked
  against account/read workspace routing and token account ID. This is local
  identity attribution, not independent JWT signature verification or an auth
  token usable by the frontend. Only a composite SHA256 key, email, workspace ID
  and plan leave the parser. Raw auth material is never serialized to snapshots.
- If identity cannot be obtained/matched, it remains null and quota is withheld;
  email alone is never used as an identity. Changed identities clear old usage.
- Last-good usage survives read errors for the same identity. Five-hour/weekly
  windows are chosen by duration, not array position. Reset tokens use only
  `rateLimitResetCredits.availableCount`, never detail-row count. Missing values
  stay null. No clock-based recovery inference or credit-redemption call exists.

## Tests

Unit tests live beside implementation. `test_fixture.rs` is a **network-free,
synthetic** app-server executable, not part of the production module. Build it
as a scratch harness binary (`[[bin]]` with `path` pointing to that file); export
`TABS_PROVIDER_TEST_FIXTURE` to the resulting absolute executable path when
running the two ignored `synthetic_` lifecycle/watchdog tests.

The ignored `installed_` tests use a fresh empty scratch home and the installed
CLI to verify initialize, signed-out account/read, rateLimits rejection, native
Store refresh/persistence and process cleanup. They never start a login or run
inference. Do not run real owner-account acceptance without separate approval.
The ignored `installed_encrypted_auth_write_and_identity_restart` test uses only
unusable synthetic credentials in a disposable home: it exercises the installed
CLI's encrypted writer with an oversized synthetic API-key payload, then verifies
synthetic ChatGPT identity attribution across two independent native file/keyring
reads against an account-response fixture. The signed-out installed protocol smoke
is separate; unusable JWT fixtures cannot prove authenticated CLI account/read.
This is storage acceptance, not a real OAuth callback or quota test. Its exact
scratch-home keyring entry is removed and the removal is verified.
Tests prefer `TMPDIR` for fixture data, falling back to normal OS temp only when
not running under the agent's explicit scratch environment.

Before parent integration, the scratch crate can compile the actual module via
`#[path = ".../provider_accounts/mod.rs"]`, and expose the existing codex
`protocol.rs`, `process.rs`, and `discovery.rs` under a small harness `mod codex`.
No alternate implementation is used. After integration use normal repository
`cargo check`, `cargo fmt --check`, and focused `cargo test provider_accounts::`.
