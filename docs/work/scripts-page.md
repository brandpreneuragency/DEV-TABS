# Scripts page — local Windows execution

## Goal and agreed scope

Integrate the supplied `Coding-Agent-Scripts-Page` reference into the existing TABS desktop shell. Owner-approved scope: **MOTHER Windows only**; jobs continue while navigating/minimized/hidden to tray, but full application exit stops owned jobs and retains history. No VPS runner, Syncthing operation, Hermes profile changes, installed-app update, commit or publication is authorized by this work.

Use the current TABS design rules/tokens: one toolbar/New script action, compact rows, borderless fields, current theme primary color. Add All scripts / Running / History to the existing sidebar. As requested on 16 November 2026, use the Tasks list/detail layout: a persistent, resizable Scripts list in the shared contextual panel and an inline editor/output in the center panel. No drawer or backdrop. Run never automatically opens Terminal; historical output remains accessible from History. Interactive prompts and automatic approval are not supported.

## Acceptance

- Existing shell/navigation integration; no separate production demo.
- Persistent create/edit/duplicate/search/delete of inline scripts, with optional working directory and confirmation.
- Native local background execution with genuine exit codes, stdout/stderr, immutable historical source snapshots and restart recovery.
- Duplicate-submission prevention, bounded concurrency/time/log output, real process-tree cancellation and full-exit cleanup.
- No elevation, public command endpoint, implicit startup execution, provider-secret export or automatic credential/approval input. Trusted owner scripts run with ordinary Windows user rights; a working directory is **not a sandbox**.
- Focused frontend/native regressions, project typecheck/lint/build and a harmless real native script smoke including failure/cancellation/persistence. Report browser fixture, native runtime and installed-app evidence separately.
- Preserve all pre-existing WIP and existing application data.

## Current state

**2026-11-16 layout update completed (Codex):** replaced the local drawers with the existing Tasks-style `PrimaryWorkspaceContent` list/detail panels. The list remains usable during editing/output; selection changes guard dirty drafts. Editor/output are nonmodal regions with normal Tab navigation; run/delete/discard confirmations remain local dialogs. Current verification: 15 Scripts UI tests and 18 neighboring layout/store/service tests passed; touched-file ESLint, project-wide typecheck and frontend build passed. Playwright screenshots at 1440x900 and 1024x768 show both panels, with no horizontal overflow in the measured list/editor/body/footer. This is browser-preview/source evidence; native execution and the installed app were not retested for this layout update. The native receipts below are historical.

**Completed: source implementation and isolated native verification.** Native WebView acceptance verified a visibly hit-testable React Run button launching PowerShell, real stdout/stderr and exit codes, idempotency, cancellation, continuation after navigation and while the native window is hidden, retained historical source/output, full-exit interruption and reopening the same native store. The focused frontend gate passes 104 tests and the native gate passes 15 tests. One independent source review found no new concrete code blocker; its two evidence holds were closed by the parent's actual regression/native receipts. No installed application, owner data or live service has been changed.

Full repository `npm run check` is **not green**: typecheck and lint pass, but four unrelated assertions remain after a bounded retry of failed files (three existing design-token violations and one Clients/Projects navigation expectation). Those unrelated WIP paths were not repaired. Production frontend build and native formatting/check pass separately.

## Key decisions

- UI/service adapters separated; only the native runner executes code.
- Native app-local JSON/file persistence follows the existing native snapshot pattern; persistent job records must not depend on a mounted WebView. Existing Dexie user data is not migrated or reset.
- Runtime choices reflect native discovery, with Windows PowerShell available through its fixed system installation; optional Python/Node/Bash only when discovered.
- No seeded production scripts. Hermes auth checks and starting Syncthing were illustrative use cases, not authorization to run them.
- Default working directory is an app-owned work folder; a user-selected directory is validated. Scripts remain trusted local code with filesystem/network access of the current non-elevated user.

## Next step

No further implementation gate is open for the agreed local-only feature. Installed-app replacement and installer packaging require a separate delivery request. The unrelated whole-repository test failures and runtime limits below remain explicit; there is no claim that the full repository gate or installed-app acceptance passed.

## Iterations

### 2026-11-16 — Codex / Tasks-style Scripts panels

- Owner requested the Tasks list/detail design instead of a drawer. Reused this workstream; preserved unrelated WIP and execution/persistence contracts.
- Moved `ScriptsDrawer.tsx` to `ScriptsPanel.tsx`; removed overlay positioning, backdrop and ordinary editor/output focus trapping. Shared shell owns the resizable list and center panel. Selected rows follow current task-card tokens.
- Added regressions for panel placement, accessible list actions, dirty script/output switching and normal editor Tab behavior. Existing save-conflict, execution confirmation, output escaping and polling regressions remain covered.
- PASS: `npm run test -- src/components/scripts/ScriptsPage.test.tsx --maxWorkers=2` (15 tests); `npm run test -- src/stores/scriptsStore.test.ts src/stores/uiStore.scripts.test.ts src/components/layout/workspace/PrimaryWorkspaceContent.test.tsx src/services/scripts/desktopClient.test.ts --maxWorkers=2` (18 tests). Both used `NODE_OPTIONS=--no-experimental-webstorage`.
- PASS: `npx eslint src/components/scripts/ScriptsPage.tsx src/components/scripts/ScriptsPanel.tsx src/components/scripts/ScriptsPage.test.tsx`; `npm run typecheck`; `npm run build` (existing bundle-size/ineffective-dynamic-import warnings). Shared-browser access was unavailable; a separate Playwright browser verified desktop/minimum-window layouts against the existing loopback Vite server.
- No Rust changes, installer build, native execution, installed-app replacement, commit or push. No data migration.

### 2026-11-12 — Hermes / GPT-6

- Read `AGENT_TASK.md`, all four screenshots and the prototype, current design authority, React/Zustand/Dexie integration and Tauri/terminal/task-only SSH code.
- Owner selected local-only execution, tray continuation/full-exit cleanup, current TABS styling and this single development record. Output-panel behavior was explained and approved.
- Baseline: dirty `main` with substantial unrelated tracked and untracked work. No reset/stash/stage/commit performed. Checks not yet run.

- Parent added the service/store and native registration/lifecycle integration; preserved the existing shell and isolated Scripts from document/task AI context. The page remains mounted with an active flag so unsaved drafts can survive navigation.
- Routing test RED: 2 expected assertion failures (Scripts still selected Tasks and lacked layout state). After integration: **6 test files / 48 tests passed**, covering store/IPC/routing and neighboring Memory/Accounts/layout regressions. Command: `NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/services/scripts/desktopClient.test.ts src/stores/scriptsStore.test.ts src/stores/uiStore.scripts.test.ts src/stores/uiStore.providerAccounts.test.ts src/stores/uiStore.memory.test.ts src/stores/uiLayoutState.test.ts`.
- Parent-touched TS/TSX files passed explicit touched-file ESLint (exit 0). Project-wide typecheck/build and native checks still pending.
- Added an isolated native acceptance example/config and frontend test entry. These are test-only and do not start production bootstrap, task authority, accounts, updater, Hermes or Syncthing. **Not yet run.**
- Permission discovery: activating a partial app-wide Tauri ACL manifest would deny unrelated existing custom commands. Follow the existing native command architecture with main-window/origin checks instead; do not broaden `default.json` or introduce a shell permission.

### Integration and actual execution verification — 2026-11-12

- Two implementation workers delivered the native Scripts module/commands and compact React UI/locales. Parent reviewed their files, integrated `PrimaryWorkspaceContent`, completed all WorkspaceMode consumers and corrected navigation-order regression expectations without reverting unrelated edits.
- Native parent regression caught a false-success case for a nonzero native command inside PowerShell. The test failed with `Succeeded`; propagating `$LASTEXITCODE` fixed it. A second native IPC regression caught a canonical Windows path (`\\?\C:\...`) rejected as the default work folder. Local-drive validation and interpreter path spelling were corrected; all four detected runtimes now pass canonical-root execution too.
- **PASS:** `cargo test --lib scripts:: -- --nocapture`: 15 passed, 0 failed. Genuine harmless executions in Windows PowerShell, Python, Node and Git Bash; exact nonzero status, EOF stdin, environment allowlist, descendant-tree cancellation, timeout, log cap, concurrency, source history, receipt/CAS and corruption/restart tests. Scratch-root fixtures only.
- **PASS:** project-wide `npm run typecheck`; explicit touched-file ESLint; scoped `git diff --check`; `cargo fmt --check`; `cargo check`. Existing unrelated native dead-code warnings remain.
- **PASS:** focused frontend/navigation gate with `--maxWorkers=2`: 11 files, 104 tests. Includes Scripts UI/IPC/store, navigation, Memory/Accounts/layout and relevant Clients navigation fixtures.
- **PASS:** `npm run build` (TypeScript + Vite). Existing large-bundle and ineffective-dynamic-import warnings remain. No installer build or live application replacement.
- **FAIL (unrelated WIP):** full `npm run check` reached 162 files / 1058 tests: 1046 passed, 12 failed. A single bounded `--maxWorkers=1` retry of its six failed files passed 57 tests and retained 4 failures: missing `--c-danger-2` in `taskProjectsKanban.css`, accent shell border in `styles/layout.css`, two gradients in `notes.css` (one assertion), and the Clients Projects `navigation.noClient`/More expectation. Other initial failures were absent on that bounded retry; no test limits/assertions were weakened.
- Native acceptance example initially exited before Rust startup (`0xc0000139`) because Cargo examples lacked the Common Controls manifest. A test-only standard manifest linked via `/MANIFEST:EMBED` corrected that environment issue. Initial native report then correctly exposed the canonical-path issue above; host exit 0 was **not** accepted as a passing report.
- **PASS:** fresh native fixture at `C:/Users/burak/AppData/Local/hermes/cache/scratch/tabs-scripts-acceptance-20261112-b`, reports `report-first.json` and `report-reopen.json` both read back with `success: true`. First report verifies the real Run button, stdout `TABS_SCRIPTS_SMOKE_OK`, stderr `TABS_SCRIPTS_SMOKE_STDERR`, exit 0, exit 7, duplicate receipt, duplicate/delete/snapshot retention, cancellation and a job running immediately before full exit. Reopen verifies that job is Interrupted and old output/source remain readable. These commands did not invoke Hermes, Syncthing or a VPS.
- Native source-component screenshots were inspected after correcting the test fixture to import the actual shell navigation CSS/markup. List, editor and Output at 1200×850 render correctly; borderless fields and 24px actions were measured. A 640px whole-window probe is below the production window's 1024px minimum and is not accepted as production narrow-layout evidence. This is a disposable native test window, **not** the installed app.
- Native test processes exited; WebView logged a nonfatal `Chrome_WidgetWin_0` unregister diagnostic on shutdown. The task-owned Vite server was stopped at completion. Loopback listeners 1421 and 14321 were checked closed; no task-owned server or test app remains running.

### Final independent-review closure

- The single read-only reviewer found **no new supported code defect**. Its verdict was evidence-blocked pending the PowerShell native-command regression and real WebView/lifecycle checks; it did not claim to have rerun tests.
- The PowerShell regression passed in the 15-test native run. The final fresh fixture `tabs-scripts-acceptance-20261112-c` then exercised the visible Run button, actual navigation out of Scripts, completion while its native window was hidden (the same visibility primitive used by production hide-to-tray), actual exit shutdown and a second native process reopening the same store. Both `report-first.json` and `report-reopen.json` were read back with `success: true`. This closes those evidence holds without another review cycle.
- A final native visual probe constrained the primary pane to **420px inside the supported 1200px window**. The editor/drawer both measured 420px, with no horizontal overflow and a hit-testable Save button; its screenshot was inspected. This supersedes the unsupported 640px whole-window probe, not a claim about physical tray clicks or the installed app.
- Later verification-harness-only edits passed project typecheck, scoped ESLint, native example compilation and final `cargo fmt --check`. Production feature inputs were unchanged from the focused tests/build/check receipts above.
- No commit, push, installer, dependency installation, production data migration, real Hermes command or Syncthing/VPS operation was performed.

## Use in a rebuilt Windows TABS

Open **Scripts → New script**, enter a name and code, choose a detected runtime and save. Advanced contains the optional working directory and timeout. **Run** starts the saved revision without opening Terminal; **Output** opens live stdout/stderr and Stop. **Running** and **History** expose active and retained runs. An enabled confirmation checkbox prompts before execution; deleting a saved script keeps its prior run snapshots and logs. The existing installed TABS has not been replaced by this source change.

### Reproducing the isolated native gate

Use a fresh `tabs-scripts-acceptance-*` directory under the absolute managed scratch directory and set `TMPDIR`, `TMP`, `TEMP`, and `TABS_SCRIPTS_ACCEPTANCE_ROOT` explicitly to the approved fixture locations. Start Vite bound only to loopback port 1421. Build the test-only example with `TAURI_CONFIG` containing `tauri.scripts-acceptance.conf.json` and:

```text
cargo rustc --example scripts_acceptance -- -C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:<absolute path>/src-tauri/examples/scripts-acceptance.manifest.xml
```

Run the example with `TABS_SCRIPTS_ACCEPTANCE_PHASE=first`, then `reopen` against the same fixture. Read the two reports, not just the process exit. Optional `TABS_SCRIPTS_ACCEPTANCE_HOLD=1` pauses for bounded source-component visual capture; it is never used by production. Do not run the ordinary production startup against owner data as a substitute for this fixture.

## Implementation map and prerequisites

- UI: `src/components/scripts/` and `src/i18n/scripts.ts` (EN/TR); existing root locale objects import the new group.
- State/adapter: `src/stores/scriptsStore.ts`, `src/services/scripts/types.ts`, `desktopClient.ts`; no localStorage canonical data and no Dexie schema reset/migration.
- Native: `src-tauri/src/scripts/` plus `commands/scripts.rs`; registration and actual-exit shutdown in `src-tauri/src/lib.rs`.
- Shell integration: `App.tsx`, `ModeNavigation`, `LeftNarrowSidebar`, `AppLayout`, `ContextPanelToggle`, `uiStore`, `uiLayoutState` and affected navigation fixtures.
- Isolated verification: `src-tauri/examples/scripts_acceptance.rs`, its manifest and `tauri.scripts-acceptance.conf.json`, `scripts/scripts-acceptance.html`, `src/services/scripts/acceptance.tsx`. Not imported by production startup.
- Data is under the existing application's local data directory, new `scripts/` subfolder. Trusted ordinary-user code only: **not a filesystem/network sandbox**. No arbitrary remote endpoint, elevation or provider-credential export. Script text and logs must not contain secrets.
- Windows PowerShell is discovered at the native system installation; optional Python/Node/Git Bash must be discoverable in the **TABS process PATH**. The test harness PATH includes locally available developer/Hermes tooling; installed-app runtime discovery has not been separately verified.
- Two active jobs maximum; one per saved script; default timeout 3600 seconds, configurable up to 86400; combined stdout/stderr cap 1 MiB with continued draining. Catalog has a guarded 32 MiB limit, with no silent history deletion. Interactive prompts, detached daemons, scheduling, VPS and custom secret injection are not supported.
