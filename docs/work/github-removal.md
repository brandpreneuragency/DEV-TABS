# GitHub workspace removal

## Current state

- Goal: remove the GitHub workspace and its feature-specific UI, services, native commands, translations, tests, dependencies, and setup/acceptance documents.
- Acceptance: no reachable GitHub workspace or registered GitHub command; obsolete mode preferences cannot restore it; supported workspaces and OpenCode retain their behavior.
- Boundaries: preserve unrelated WIP, application data, secure storage, provider authentication, source repository URLs, releases, and updater configuration. Historical database schemas remain for data compatibility.
- Verification: focused routing/persistence and assistant regressions, project typecheck/lint/tests/build, Rust formatting and compile checks. Browser preview and installed desktop acceptance are distinct; no production access is required.
- Status: complete in source. Feature UI, routing, services, native registration, translations and dependencies are removed. Focused regressions, typecheck, lint, production build and Rust checks passed; the full test suite has unrelated failures detailed below.
- Next step: none for GitHub source removal. Unrelated design/CRM test repairs and installed desktop acceptance remain outside this workstream.

## Iterations

### 2026-10-29 - Codex

- Baseline: navigation/layout tests passed, 31 tests in 2 files.
- Updated navigation expectations before implementation: failed on the remaining GitHub button as expected.
- Removed the navigation entry; all 4 navigation tests passed.
- No commit, push, installer, production operation, or live-data cleanup is authorized by this work.

### 2026-10-29 - Codex continuation

- Continued from the existing removal changes without reverting unrelated WIP.
- Source audit found no remaining GitHub feature imports or native registrations. Historical database schema and retired-setting regression fixtures remain deliberately.
- Removed obsolete GitHub egress requirements from the repository guide and active OpenCode native contract. Historical iteration notes remain unchanged.
- Validation: completed below. No unrelated source edits were made to make the full suite pass.

## Verification results

- `npm run test -- src/stores/uiStore.retiredMode.test.ts src/stores/uiLayoutState.test.ts src/components/header/ModeNavigation.test.tsx src/components/layout/LeftNarrowSidebar.test.tsx`: PASS, 4 files / 50 tests. Old mode preferences cannot restore the workspace or its layout entry.
- `npm run check`: FAILED at the test stage. Project-wide typecheck passed; ESLint passed with 0 errors / 18 warnings, including warnings from the pre-existing `.worktrees/repos` source copy. Tests: 130 files passed / 3 failed; 916 tests passed / 5 failed. The chained build was not reached.
- Full-suite failures: undefined `--c-danger-2` in Kanban CSS; an accent border in `src/styles/layout.css`; two gradients in Notes CSS; the Clients workspace test expecting the old `navigation.noClient` label and More menu; one calendar test exceeding its 5000 ms timeout. These are outside the GitHub feature removal.
- `npm run test -- src/components/taskManager/TaskCalendarView.test.tsx --maxWorkers=1`: PASS, all 8 tests, including the full-suite timeout case. The four deterministic style/CRM failures remain unresolved in their existing WIP.
- `npm run build`: PASS. Existing chunk-size and ineffective dynamic-import warnings remain.
- `cargo fmt --check` from `src-tauri`: PASS.
- `cargo check --locked --offline` from `src-tauri`: PASS, 70 existing unused-code warnings outside the removed feature.
- `git -c core.safecrlf=false diff --check`: PASS.
- Final source audit: no active GitHub workspace imports, UI entry, native module/command registration, translations, feature CSS or `diff3` / `aes-gcm` dependencies remain. Historical database tables and regression fixtures preserve saved records; provider authentication, source URLs and updater configuration retain their independent uses.
- Browser preview, native GUI/installed-app acceptance and installer packaging: NOT RUN. No live database, secure-storage, production, commit or push operation was performed.
