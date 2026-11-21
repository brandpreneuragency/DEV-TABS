# Provider accounts: module boundaries

This feature monitors provider accounts. It is intentionally not another chat
runtime, remote-session service, task authority, or global credential pool.

## Ownership

- `types.ts`: small shared account identity, usage snapshot and consumer evidence
  contract. Managed account IDs are local references, not email addresses or
  credential paths. A null observation identity key means matching is unavailable.
- `desktopClient.ts`: the only frontend Tauri door for this module. It accepts
  account/login IDs and an explicitly entered Inception API key for native-only
  storage. Saved credentials are never returned. No hosts, file paths, arbitrary
  RPC methods or shell commands are accepted.
- `model.ts`: pure presentation rules. Missing quota is unknown; reset timestamps
  do not prove a refill. Account bindings require the provider plus the composite
  principal/workspace key, never email equality.
- `store.ts`: transient UI state and async ownership. Native storage owns durable
  accounts/snapshots; no second auth/persistence copy in Zustand, Dexie or browser
  localStorage. Cancellation and a replacement login invalidate late responses.
- `cards.ts`: presentation-only card IDs in the existing Dexie settings table
  (`providerAccounts.cardIds.v1`). No identity, credentials or quota are copied.
  Add account selects one unlisted native slot. Connect account starts sign-in
  for a slot that needs it. Older preferences containing only `ids` still show
  previously connected or configured accounts. Removing a card records its slot
  in `removedIds` and stops monitoring it in Accounts and the tray. Adding that
  slot again resumes monitoring with its existing provider login.
  Both views refresh only listed accounts. A failed preference write keeps the
  previous selection, and a failed read blocks card edits until the next load.
- `src-tauri/src/provider_accounts/`: Codex-owned isolated login homes, supported
  account protocol, safe local snapshots and supervised process lifecycle.
  Claude, Grok and CommandCode have separate native adapters, homes and snapshots;
  none of their logins is imported from the chat adapters.
- `src-tauri/src/provider_connections/`: independent read-only observations of
  the four approved application locations. Stored/configured identities never
  become runtime-confirmed merely because an application process exists.
- `src/components/providerAccounts/`: display and explicit owner actions only.
  `BankedResets` is shared by Accounts and tray. It shows the last reported count,
  per-kind count/expiry and independent observation time, including seconds,
  fractional seconds when present and the local UTC offset. Unknown is not zero;
  explicit no-expiry is not a missing date. Passed expiries are marked expired /
  awaiting refresh without silently recalculating the authoritative count.

The existing `services/codex`, `services/providers` and chat stores retain their
current ownership. Opening this dashboard, refreshing quotas, or connecting a
monitoring account does not switch their accounts, run a model, redeem resets or
change another application's login.

## Adding another provider

### Current provider options

| Provider | Connection | Supported observation |
| --- | --- | --- |
| Codex | Four existing isolated ChatGPT login slots | Duration-tagged limits/reset credits from app-server; unchanged storage path |
| Claude | One isolated Claude Code OAuth subscription login | Owner-approved undocumented OAuth usage endpoint; five-hour/all-model weekly/Fable weekly quota, and banked grants when exposed |
| Grok | One isolated Grok Build login | CLI-owned ACP account/billing extensions, subject to installed protocol support |
| CommandCode | One isolated native CommandCode login | `status --json`, shown as configured login, not verified live quota |
| Inception Labs | One separate native-keyring API key | Read-only `GET /v1/models` checks access; published tier limits and unknown live balance |

Claude, Grok and CommandCode login is completed in a separate vendor CLI console. The native process
owns browser/fallback prompts; no terminal transcript or credential is sent to the
renderer. TABS polls only the owned process and reads the supported account status
after completion. Cancellation/replacement is bound to exact account/login IDs.

Claude and CommandCode do not expose a documented standalone quota polling
command. Claude has an explicit owner-approved exception (2026-11-14): the native
adapter reads its own isolated OAuth profile and calls the undocumented usage
endpoint. No API key, Desktop credential access, token rotation or inference is
used. Requests have native caching/backoff shared by the page and tray. Expired
access requires signing in again. Missing fields stay unknown; reset credits and
monthly quota are never invented. The UI discloses the unsupported endpoint.
CommandCode continues to show configured-only status and unavailable quota. Usage
website buttons open fixed official URLs and explicitly warn that the browser
account can differ from the isolated CLI account. No Admin/management API keys or
other private subscription endpoints are introduced. Grok prepaid balances are USD
cents, separate from allowance percentages and Codex reset-credit counts.

Banked resets have one provider-neutral display, not a provider-neutral credential
or redemption API. Codex supplies its authoritative count plus sanitized expiry
details; Claude supplies grant counts and `ends_at` when its response permits it.
Grok, CommandCode and Inception currently report no reset inventory through their
implemented contracts; their cards state that it is unreported rather than zero.
Claude's generic TABS User-Agent can receive `surface` denial: the UI states that
limit, keeps last-known inventory when available and does not impersonate a CLI.
Banked rights are not a promise of immediate redemption. No reset button, grant
claim, clock-based refill, monthly estimate or extra credential source is added.

Vendor CLI credentials are vendor-owned files in their app-private homes on
Windows; they do **not** inherit Codex's encrypted-storage guarantee. This is
account/configuration separation, not a security sandbox against other processes
running as the same Windows user. Claude Console, third-party/BYOK auth and
status-line hooks are outside this iteration.

Inception uses `inception-1`, not a CLI login. The masked input is cleared before
its native request and never enters Zustand, Dexie, localStorage, snapshots or
logs. Its separate native keyring entry is scoped to the canonical application
data root. Replacing the key does not import or retarget chat/Hermes credentials.
The API-key command is main-window-only; the tray remains observation-only and
does not poll this provider for unsupported quotas. No capability scope expands.

The model-list check establishes API access, not principal/workspace identity,
plan, remaining free credit or runtime use in another app. The 100-million-token
starting grant is one-time and shared across models, not a current balance. Both
Free and PAYG published per-minute limits are shown without guessing the account
tier. There is no documented public balance endpoint or account-usage stream;
this first version does not instrument requests or manufacture local usage.

Official contracts checked for this extension:
- [Inception authentication](https://docs.inceptionlabs.ai/get-started/authentication),
  [rate limits](https://docs.inceptionlabs.ai/get-started/rate-limits),
  [free credit and usage](https://docs.inceptionlabs.ai/resources/faq),
  [public API specification](https://api.inceptionlabs.ai/openapi.json).
- [Claude CLI](https://code.claude.com/docs/en/cli-reference),
  [multiple accounts/auth](https://code.claude.com/docs/en/authentication).
- [Grok ACP](https://docs.x.ai/build/cli/headless-scripting#acp),
  [vendor auth extension](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/auth.rs),
  [vendor billing extension](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).
- [CommandCode CLI/status](https://commandcode.ai/docs/reference/cli),
  [usage limits](https://commandcode.ai/docs/resources/usage-limits).

### Extension procedure

1. Verify its supported authentication and account-usage surface. A subscription,
   an API cash balance and a model's per-window quota are different metrics.
2. Add a provider-specific native collector behind the same sanitized account
   contract. Keep its token lifecycle and parsing separate from Codex and from
   consumer observations. Do not expand this command surface into arbitrary HTTP,
   shell, credential lookup or remote RPC.
3. Describe actual capabilities in `ACCOUNT_PROVIDERS`; do not manufacture missing
   windows or a currency value. Extend metrics explicitly when needed.
4. Add narrow normalization, missing-data, account-isolation and failure tests.
   Exercise the real supported adapter with isolated fixtures before owner login.

## Later AI Chat integration

Account discovery/auth metadata can be shared; quota monitoring and chat execution
remain separate adapters. A future chat connection must explicitly select a local
`accountId` and bind it to the conversation/run lifetime. Refreshing a dashboard
or changing a global default must not silently retarget an existing conversation.
A provider being monitorable does not prove its subscription is usable by the
existing chat transport; verify that execution/billing route separately.

## Verification limits

Browser preview can verify navigation/rendering only; native credentials remain
unavailable there. Owner-completed login and authenticated quota reads are a
separate acceptance step. The current connection collectors prove configured
identity only. Actual per-request identity requires a supported runtime signal;
unknown evidence must stay unknown until that signal exists.

Workstream and exact current checks: `docs/work/provider-accounts.md`.
