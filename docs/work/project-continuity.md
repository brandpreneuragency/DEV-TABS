# Project continuity — local-source MVP

## Current handoff

- **Goal:** give one existing TABS Project explicit local source-entry and living-work-record references, with a read-only **Where did we leave off? / Nerede kaldık?** view. Project id, not a name, is the linkage anchor across harnesses.
- **Scope:** `C:/Users/burak/MOTHER/DEV/TABS-local`, MOTHER/MSI source only. User authorized isolated technical checks; installed-app and owner trials remain deferred. No commits, push, installation/package, VPS connection, real task mutations or native application-state changes were performed.
- **State:** implemented and source-verified. Final five focused/regression suites passed (58 tests); project-wide typecheck, touched-file ESLint and frontend build passed. The independent review's authority-switch blocker was reproduced and fixed in one parent correction round. This is **not** installed-app acceptance or a real-data trial.
- **Next action:** owner review of this source MVP, then an explicitly approved desktop trial using selected non-sensitive project documents. No automatic trial, publication or task execution follows from this record.
- Existing dirty WIP was inspected and retained. Only two insertion lines were added to the already-modified Kanban component; localized namespaces were added to already-modified English/Turkish dictionaries. No server schema, task store, task-authority lifecycle, DB migration, native command or capability was changed.

## Acceptance and design

1. Projects board → expand a project's continuity disclosure. The view exposes the stable Project id and two roles: **Project source entry** (e.g. README/AGENTS) and **Living work record**. The MVP intentionally references explicit `.md`/`.txt` entry files, not entire repositories/folders, arbitrary URLs, or harness session databases.
2. **Select reference** opens the existing desktop file picker and persists only the selected path. It does not read the file. **Reselect file and read** requires selecting that exact file again, checks metadata, reads through the existing FS adapter and shows escaped plain text. Markdown links, HTML, scripts and images are not rendered or executed.
3. References are local Dexie `settings` entries under `projectContinuityV1:`. Identity is `[authority databaseId or local-only, Project.id, Project.createdAt]`. Names/client display labels are never used for matching. Rename retains the binding; a replacement id/creation tuple or authority database has its own empty namespace. Switching from local-only to authority mode deliberately requires explicit relinking. Authority generation is not part of the binding because it increments on ordinary mutations (`tools/task-authority/tasks.py`).
4. Transactional revision compare-and-set prevents stale local reference writes. Project existence/identity and stored schema are checked on load/save. No fields are added to Project RPC payloads, and no task/project row is written by this feature. Local unlink removes only the reference; it does not delete the file. Orphaned namespaces are retained, not automatically cleaned or reassigned.
5. Content stays in component memory only. It is cleared on another action, read failure or disclosure unmount. Every displayed preview is explicitly labeled a possibly-stale snapshot with read time and optional file modification time; nothing claims live task, agent or filesystem status. Stored reference availability is always labeled unchecked until an explicit read.
6. Components use services, not direct Tauri imports. English/Turkish strings and existing UI tokens are used. The disclosure lives in the existing project-column scroll owner. A Dexie live query observes the exact project/authority/reference rows; changed identity or reference revision creates a new keyed interaction session. Old snapshots and pending load/picker/read publications are discarded, including observed away-and-back transitions. Preview publication also rechecks revision/identity; persistent writes retain repository CAS.

## Evidence and changed source

- [Local reference model/persistence](../../src/services/projectContinuity.ts) and [identity/persistence/negative tests](../../src/services/projectContinuity.test.ts).
- [Explicit file selection/read service](../../src/services/projectContinuityFiles.ts), [negative read tests](../../src/services/projectContinuityFiles.test.ts), [disposable filesystem/desktop adapter integration](../../src/services/projectContinuityFiles.integration.test.ts).
- [Continuity UI](../../src/components/taskManager/ProjectContinuity.tsx), [UI integration tests](../../src/components/taskManager/ProjectContinuity.test.tsx), [scoped CSS](../../src/components/taskManager/projectContinuity.css).
- [Projects board integration](../../src/components/taskManager/TaskProjectsKanban.tsx), [English](../../src/i18n/en.ts), [Turkish](../../src/i18n/tr.ts).
- Existing boundaries inspected: [Project type](../../src/types/index.ts), [project store](../../src/stores/projectStore.ts), [DB settings table](../../src/services/db.ts), [authority metadata](../../src/services/taskAuthority/cache.ts), [FS adapter](../../src/services/fs-adapter.ts), [desktop connector](../../src/services/tauri-folder-connector.ts), [native capabilities](../../src-tauri/capabilities/default.json). These were not modified.

## Verification — 2026-11-13, Hermes Agent

Final evidence collected around **11:06 Europe/Istanbul**, using Node `Intl.DateTimeFormat` with the explicit timezone. Git Bash `TZ=Europe/Istanbul date` returned GMT here and was not used as the Istanbul timestamp.

```bash
NODE_OPTIONS=--no-experimental-webstorage npm run test -- src/services/projectContinuity.test.ts src/services/projectContinuityFiles.test.ts src/services/projectContinuityFiles.integration.test.ts src/components/taskManager/ProjectContinuity.test.tsx src/components/taskManager/TaskProjectsKanban.test.tsx --pool=threads --maxWorkers=2
```

**PASS:** 5 files, 52 tests, exit 0. Real repository/Dexie logic runs against disposable fake-indexeddb databases, including close/reopen, equal-name isolation, rename, deletion/replacement, authority identity changes, stale-write rejection and malformed metadata. UI tests compose the real local repository and read service with a mocked FS boundary; they cover save/reopen/read, inert markup, failed-read clearing and unmount isolation. The separate filesystem integration uses a disposable file under agent `TMPDIR`, the real read service, FS adapter and `TauriFolderConnector`; **only native dialog/FS plugins are substituted with fixture selection and Node filesystem calls**. It reads/refreshes/removes the fixture and verifies unchanged bytes after reading. This is not native IPC or installed-app evidence.

```bash
npm run typecheck
npm run build
npx --no-install eslint src/services/projectContinuity*.ts src/components/taskManager/ProjectContinuity.tsx src/components/taskManager/ProjectContinuity.test.tsx src/components/taskManager/TaskProjectsKanban.tsx src/i18n/en.ts src/i18n/tr.ts
```

**PASS:** project-wide typecheck; frontend `tsc -b && vite build`; touched-file lint, all exit 0. Build emits chunk-size and ineffective dynamic-import warnings for mammoth/crmStore; no unrelated bundling refactor was made. Build writes ordinary ignored `dist/` outputs only; no Tauri packaging or installation.

Evidence history, retained honestly:
- First default fork-pool test invocation failed to start its worker within 60 seconds. Switched to process-scoped Web Storage disabling plus Vitest threads; no host configuration changed.
- Initial new-module test imports failed because implementation did not yet exist. Behavioral RED then demonstrated ten path/corrupt-metadata failures; GREEN passed after validation. A separate reserved Windows device-path test failed before its guard, then passed. This is Quick/MVP mixed test-first/test-after evidence, **not a claim of strict TDD for every line**.
- Initial typecheck/lint exposed a parameter-property restriction (`erasableSyntaxOnly`) and `no-control-regex`; corrected without weakening config. Follow-up build caught `unknown` narrowing; corrected, final build passed.

## Critical limits and remaining owner trials

- **Local-only references, not cross-harness sync.** Hermes/Codex/ChatGPT Work receive no automatic attachment, context export, identity propagation or execution. The same Project id and selected living record can be used explicitly by an owner/harness. Nothing inspects chats, native credentials or agent state.
- Windows absolute `.md`/`.txt` paths only; browser preview is deliberately unavailable for file selection/read. Two explicit reference slots, no folder scanning, watcher, recursive discovery, HTTP requests, URL opening or command execution.
- Lexical checks reject traversal, UNC/URL/device paths, hidden paths and obvious VAULT/credential/secret locations. **These are not a filesystem sandbox:** the existing adapter does not expose canonical-path/symlink identity or bounded streaming. An owner-selected junction/symlink or concurrent replacement cannot be strongly contained by this renderer layer. Select approved ordinary non-sensitive files only; adversarial-filesystem hardening requires a separately scoped native safe-read contract, not broader permissions.
- Preview limit is 256,000 bytes checked before and after reading; stat/read/stat catches ordinary size/mtime drift, not same-metadata replacement, nor a hard allocation cap if a file grows during read. No claim of transactionally consistent filesystem snapshots.
- No native picker/IPC, browser/manual visual trial, installed-app, real task-data, VPS or production checks were run. Full unrelated test/lint suite and Rust checks were not required/run; Rust was untouched.
- Owner trial after waking: open an approved isolated desktop context; confirm Turkish/English disclosure usability and keyboard access, narrow-column wrapping, actual native picker/read, close/reopen persistence, missing-file feedback and exact-file reselection. Observe unchanged task/project authority and no remote sync/execution. Do not run against real data merely because source tests passed.
- Parent agent owns combined Journal/shared-instruction/skill reporting; this delegate did not edit those locations.

## Parent verification — 2026-11-13

- Re-read the implementation and live package scripts. Project-wide typecheck,
  selected-file ESLint and `npm run build` passed independently. The same
  chunk-size/dynamic-import warnings remain non-blocking; no packaging/install.
- Parent's first five-suite run passed the three service suites (20 tests), but
  two UI thread workers timed out before starting. That run exited 1 and is not
  labeled a clean pass. Retried only the two affected UI suites with
  `NODE_OPTIONS=--no-experimental-webstorage` and `--pool=threads --maxWorkers=1`:
  both files passed, 32 tests, exit 0. No app/test configuration was weakened.
- One independent source review reported B1: an open panel retained old paths and
  content after a supported local-only to authority transition with unchanged
  Project id/createdAt. No persisted cross-authority write was found.
- Added four focused regressions and observed all four fail before the fix.
  Added persisted-row observation and keyed interaction-session invalidation;
  all four then passed. Added unavailable-metadata recovery and away-and-back
  cases, without changing the persistence, native-read or task-authority contracts.
- Final same-snapshot run with `--pool=threads --maxWorkers=1`: **5 suites,
  58 tests PASS**, touched-file ESLint PASS, `npm run build` (including `tsc -b`)
  PASS, selected Git whitespace checks PASS. B1 is closed by parent reproduction
  and regression verification, not by a fabricated second reviewer approval.
- Exact final command output: MOTHER
  `TOOLS/maintenance/26-11-13-10.47-Agent-Continuity-Preparation/final-tabs-checks.log`.
  One combined independent review and one correction round were used. Owner
  trials and actual native picker/installed-app acceptance remain deferred.
