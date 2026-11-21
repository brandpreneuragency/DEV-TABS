# OpenCode native contract

Owned by the native/bridge delegate. Implementation status belongs only in `opencode-chat-wrapper.md`.

## Native IPC (frozen command names)

`src-tauri/src/commands/open_code.rs` and `src-tauri/src/open_code/types.rs` define the contract.
All DTO keys and command arguments use camelCase. Errors are `{code, message}`.

- `open_code_status`, `open_code_discover`, `open_code_subscribe`, `open_code_unsubscribe`: `Status`.
- `open_code_list_models`: `ModelSummary[]`; `open_code_list_agents`: `AgentSummary[]`.
- `open_code_create_session({threadId,title?,model?,agent?})`: `SessionDetail`.
- `open_code_rebind_sessions({sessionIds})`: `RebindOutcome[]` (server verifies marker/location/project).
- `open_code_get_session({sessionId})`: `SessionDetail`.
- `open_code_get_messages({sessionId})`: `MessageView[]`, authoritative ordered `/context`, not a page.
- `open_code_prompt({sessionId,admissionId,text})`: `InboxAdmission`. Persist stable `msg_...` admission IDs before sending.
- `open_code_interrupt({sessionId})`: boolean; interrupts only the owned session.
- `open_code_switch_model({sessionId,model})`, `open_code_switch_agent({sessionId,agent})`: void.
- `open_code_list_forms({sessionId})`: `FormSummary[]`; `open_code_reply_form({sessionId,formId,answer})`: void.
- `open_code_list_permissions({sessionId})`: `PermissionSummary[]`.
- `open_code_reply_permission({sessionId,requestId,decision,message?})`: void. Decision: once/always/reject.
- `open_code_delete_session({sessionId})`: void, explicit server deletion only.

`ModelRefView = {id,providerId,variant?:string|null}`.
Event `open_code://event` carries `{kind:'lifecycle',state,generation,streaming,detail}` or
`{kind:'stream',event:StreamEvent}`. `StreamEvent` has `sessionId,kind,created,assistantMessageId,partId,seq,delta,tool,error,status`.
Nullable DTO fields serialize as null. Native drops foreign session events before IPC.
`FormFieldView.schema` additionally contains the complete bounded original `FormField` object.
Use `schema` for form rendering/validation so defaults, custom entries, conditions and numeric/text bounds survive IPC.
The legacy summary fields remain for compatibility. Do not rebuild schemas from summary fields alone.
Generation detects service identity changes, not a transcript replay boundary. Reconcile on reconnect.
Do not persist PID, endpoint or service credentials in frontend state.

## Shared service startup

Native discovery starts the installed OpenCode V2 CLI with `service start` only
when registration is missing or the validated loopback connection is refused.
Healthy services are reused; authorization/protocol/version/registration errors
do not cause startup or repair. Concurrent startup is serialized and failed
launches back off for 15 seconds. The launcher has a 20-second timeout, no shell,
no captured output, and no kill-on-close job ownership of the shared daemon.
TABS never stops or restarts the service on exit. Before publishing a connected
location, await `GET /api/integration` (V2's plugin-activation barrier) so the first
model/agent reads do not cache an empty cold-start snapshot.

## Business bridge (implementation boundary)

Frontend imports `startToolBridge` from `src/services/openCode/toolBridge.ts` once at app startup.
Before prompt submission call `bindToolContext({sessionId,appThreadId,admissionId,scope,modelId})`.
`scope` reuses the captured provider-neutral shape currently named `CodexScope`.
Captured contexts stay tied to their admitted turn; no active-editor fallback.
Bridge exposes the existing business tool names and schemas from `toolsForScope`.
Plugin requires native binding and OpenCode permission approval before each mutation.
Do not pass the executor's resolved `agent` into `ctx.permission.assert`; let the session resolve its policy.
On installed V2 2.1.3 the explicit executor-agent override skipped the session ask rule in live acceptance;
omitting it restored observed approve/reject requests. Keep this boundary covered by plugin and native acceptance tests.
Native validates owned session, bound user message, actual running tool call and exact input before relay.
Stable call identity preserves existing operation receipts, document intents and task CAS.

The neutral executor reuses `codex/businessTools.ts` without copying its business implementation.
Keep its receipt/pending/run/document-intent tables and `codex/sessionTypes.ts` recovery types.
Keep its scoped filesystem adapters/commands (`codex_list_scoped_documents`, `codex_scoped_document_hash`,
`codex_create_scoped_document`, plus context capture's scoped text read) until a separate neutral rename is complete.
Those are business filesystem operations, not legacy chat execution routes.
Task writes continue through the existing cache/CAS synchronization pipeline; a local business receipt is not a VPS acknowledgement.
On stop call `cancelToolContext(sessionId)` before native interrupt, so renderer work also sees cancellation immediately.
The send path must generate its stable admission ID first, capture scope, then call `bindToolContext` before
`open_code_prompt`. Pass that same ID to both operations. Failed bridge initialization must not admit the prompt.
Current `OpenCodeSessionService.send` is frontend-owned; this delegate does not edit it.

## Parent registration

Register `mod open_code; mod tab_bridge; pub mod commands::open_code`.
Manage `commands::open_code::create_host(app.handle())?` as `Arc<Host>`.
Register all command functions above plus bridge functions exported in that same command module.
Native dependency request: `tiny_http = "0.12"` for a bounded loopback HTTP bridge (no hand-written HTTP parser).
Use existing reqwest, serde_json, uuid, base64. Preserve existing Cargo changes.

Bridge commands to register: `open_code_tool_start`, `open_code_tool_bind`, `open_code_tool_validate`, `open_code_tool_complete`, `open_code_tool_stop`.
`Host::new` prepares the dependency-free plugin in the private durable workspace.
`open_code_tool_start` authenticates an in-memory listener token through the plugin's scoped RPC.
It can fail until asynchronous plugin activation completes; retry from the frontend with a bounded delay.
All registration calls belong to `commands::open_code`; `tab_bridge` has no separate Tauri command module.
Native session deletion refuses sessions with descendants because OpenCode deletion is recursive.
Remove descendants only through a separate explicit owner selection; no foreign-child deletion is inferred.

## Native retirement boundary

The CLI chat runner and its command module are removed:
`cli_providers/runs.rs`, `commands/cli_runs.rs`. Probe model metadata remains unchanged;
only the unused runner-specific reasoning-effort caches were removed from the probe.
The temporary `examples/open_code_transport_check.rs` is removed because the registered native module
now contains the useful synthetic shared-service acceptance test itself.

Parent must remove these shared registrations and initializers:

- `commands/mod.rs`: `pub mod cli_runs;`.
- `lib.rs`: `.manage(Arc::new(cli_providers::runs::RunRegistry::default()))`.
- `lib.rs` handler: `commands::cli_runs::{cli_provider_run,cli_provider_stop}`.
- The old `commands::cli_providers::{cli_provider_probe,cli_provider_default_workspace}` handlers
  can also be removed after Luna's old frontend branch removal. Provider Accounts invokes neither;
  keep the separate native `cli_providers::discovery` module it imports. The unregistered command
  source can remain until parent removes its module declaration.
- `lib.rs` handler: `commands::codex::{codex_discover,codex_connect,codex_begin_login,codex_cancel_login,
  codex_status,codex_list_models,codex_default_workspace,codex_read_thread,codex_start_thread,
  codex_resume_thread,codex_start_turn,codex_interrupt_turn,codex_reply_request,codex_replay_events,
  codex_ack_events,codex_disconnect}`.
- `lib.rs` setup: the whole `event_window` / `protected_roots` / `codex_home` / `journal_dir` /
  `CodexHost::new(...).with_protected_roots(...).with_journal(...)` block, immediately after managing
  the OpenCode host and before the main-window close handler. Do not delete journal files on disk.

Keep `mod codex;`: Provider Accounts directly uses `codex::discovery` and `codex::CliOwnedJob`
(`provider_accounts/client.rs`, `external_cli.rs`, `grok.rs`). Its shared error types also serve FS commands.
Keep `mod cli_providers;`: Provider Accounts uses its discovery launcher, independent of chat.
Keep the four `commands::codex` scoped FS commands registered. Removing the old host initializer does not
affect them: they do not use `State<Arc<CodexHost>>`.
The old Codex host source can remain uninitialized/unregistered until shared account primitives are
extracted in a separately bounded change; no old chat engine is reachable once those entries are removed.

## Final bounded review

- `FormSummary.fields[].schema` is authoritative and preserves the original field object, including
  `when`, explicit false/zero/empty defaults, `min/max`, `minLength/maxLength`, `pattern`, `custom`,
  option descriptions and boolean `required`. Summary fields are compatibility-only. Oversized
  field definitions become `type: unsupported`; frontend must reject them, never infer a permissive control.
- App currently starts the renderer singleton without an effect cleanup. This is intentional for
  React StrictMode; do not call its disposer from each StrictMode effect cleanup. The disposer itself
  is now idempotent. A failed startup can be retried. Renderer reload loses captured scopes and
  explicitly rejects tool calls until a new captured turn is bound; do not reconstruct scope from UI selection.
- Native reconnect retains bindings when the bridge endpoint/token is unchanged. Rebinding the same
  admission with different tool schemas fails; renderer also rejects changed captured context for the
  same admission. A new admission expires pending requests from the previous turn. Transcript validation
  additionally checks the preceding user message and exact running call/input.
- `Host::shutdown()` stops the SSE subscription and native tool listener and drops the cached service
  credential. Parent should call it for actual application exit (Tauri `RunEvent::Exit`), NOT hide-to-tray,
  window focus changes, thread changes or React effect cleanup. Never stop the shared OpenCode service.
  In the application's final `.build(context)?.run(|app, event| ...)` callback use
  `if matches!(event, tauri::RunEvent::Exit) { if let Some(host) = app.try_state::<std::sync::Arc<open_code::Host>>() { host.shutdown(); } }`.
  Preserve the existing close-to-tray behavior and other run-event handling.
- Service error bodies are not safe IPC text: RPC validation errors can echo the bootstrap token.
  Native now returns only classified static request errors. Basic authorization headers are marked
  sensitive; credentials and bridge bootstrap input remain absent from public DTOs, disk writes and logs.
- `tiny_http` bounds application workers/body length but does not expose per-connection header/body
  read deadlines here. A hostile local process can still stall accepted sockets; this is a local
  availability limit, not a foreign-session authorization bypass. Do not claim total socket-resource bounds.

Verification in this retirement slice: the initial targeted native test could not compile because shared
`commands/mod.rs` and `lib.rs` still reference the removed CLI runner. This is an integration dependency,
not observed RED evidence for the credential regression. Parent must apply the exact removals above,
then run the targeted `rpc_errors_never_echo_credentials_or_inputs_to_ipc`,
`form_ipc_preserves_complete_raw_field_metadata`, and
`bindings_preserve_identical_reconnect_and_reject_same_turn_schema_drift` tests with the final native gate.
`npm run test -- src/services/openCode/toolBridge.test.ts`: 2 passed. The first attempt had one
async-timing assertion failure; the corrected test waits for the native stop invocation. The implementation
also serializes subsequent startup behind the previous native stop. Targeted ESLint passed. No broad gate
or live model execution was repeated in this slice. Native changes are formatted but NOT compile-verified
until the shared retirement registrations are updated.
