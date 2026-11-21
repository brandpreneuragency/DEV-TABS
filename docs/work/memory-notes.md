# Memory collections in TABS — Notes, Resources, To-Read and Someday

## Goal and scope

Add a read-only **Memory → Notes** workspace to the Windows Tauri desktop app, using the existing Notes visual conventions. Read only the local `MOTHER/MEMORY/Notes` replica. Rename the existing database-backed Notes workspace to **Quick Notes / Hızlı Notlar**, preserving its data and internal identities.

Owner selected this development record on 2026-10-29. On 2026-10-31 the owner separately requested an installed-app update and explicitly approved using the current source despite the legacy-chat database reset; no remote access or Memory writer integration is selected.

**Active continuation:** installed Windows TABS update completed from the current source. The owner approved the v22 legacy-chat transition. Existing installer/executable recovery copies are retained; profile directory identities remain present. No further collection or remote access is selected.

## Acceptance

- Memory has a Notes page with searchable cards, readable Markdown detail and manual refresh.
- Resources adds category/search filtering, explicit source links, full relative-path identities and independent collection state. Support direct records, type folders and unambiguous single-record bundles without traversing asset folders.
- To-Read adds a third independent read-only page with search/sort/detail/source links, no category reinterpretation and no read-status mutation. Support direct Markdown and unambiguous one-level asset bundles; do not choose a primary URL from different captured originals or incidental citations.
- Someday adds an independent read-only idea page; read one unambiguous Markdown record per direct idea folder, with no record writes, tasks or reminders.
- Only direct Markdown owner notes in the selected Notes collection are read; management files, hidden files, conflict copies, symlinks and sibling collections are not ordinary cards.
- File content is read-only, stays local, and is not automatically attached to an AI conversation. No writes, imports, deletes, moves or duplicate record authority.
- Loading, missing folder, unsupported browser runtime, empty/filter-empty and read failures are distinct visible states. Refresh does not present a failed read as an empty synchronized collection.
- Quick Notes keeps its existing database, drafts, identifiers, actions and storage semantics; only user-facing workspace naming changes in English and Turkish.
- Navigation enters/exits Memory correctly without accidentally targeting Tasks, CRM, an unrelated document or its assistant context.
- Focused service/UI/navigation regressions, touched-file lint, project-wide typecheck and source frontend build pass. Exercise the rendered source flow with synthetic records. Report actual Tauri/native and installed-app checks separately.

## Current state

**Installed update complete.** The owner explicitly chose the current source including its legacy-chat transition. The old unrelated Accounts test unused binding was removed as a minimal build unblocker; project-wide `npm run typecheck` passed, and Accounts plus isolated chat-migration tests passed (3 files / 18 tests). Local NSIS build and `/S /UPDATE` install exited 0. The installed executable matches the fresh release apart from the single documented Tauri bundle marker, and the installed app opened normally. In the real installed UI Notes, Resources, To-Read and Someday loaded local cards; a Someday detail opened. Broader application, provider and task workflows were not reaccepted.

**Someday source implementation is complete.** Memory → Someday / Bir Gün uses the shared cards, search, sort, Markdown detail and explicit source links, with independent snapshot and selection state. One direct idea folder produces at most one card; root files and asset trees are not read. Ambiguous, unsafe and conflict entries are reported, not merged. No task, reminder, record mutation or new permission is added. Two representative local records and the collection rules were inspected read-only.

The combined Memory/Quick Notes regression run passed **27 files / 119 tests**; touched-file ESLint and whitespace checks passed, and the Vite bundle was emitted. The previous typecheck blocker was corrected for installation as described above. Previous To-Read milestone follows.

**To-Read source implementation is complete.** Memory → To-Read / Okunacaklar reuses the shared cards, search, title/update sorting, full Markdown detail and explicit source links, with a separate snapshot/selection lifecycle. Final combined checks: **23 files / 110 tests passed**, touched-file ESLint and whitespace checks clean, Vite frontend bundle emitted. Existing Notes, Resources and Quick Notes regressions pass.

To-Read handles direct Markdown and one-level single-record asset bundles. Opening a record does not mark it read, change retention, create a reminder or write a file. Explicit `source_metadata.original_source_literal` values are decoded within the known bounded string representation only when they resolve to one safe unambiguous URL; missing sources remain absent and body citations are not promoted. The empty legacy References folder stays untouched. No new CSS was needed; this continuation has mounted-component tests, not a fresh native/installed or visual acceptance claim.

Resources source implementation and bounded verification are complete. Memory → Resources / Kaynaklar has category plus search filters, read-only shared cards/details, explicit source links and an independent snapshot store. The parent reviewed the service handoff and reran the integrated checks: **18 files / 90 tests passed**, touched-file ESLint and whitespace/token checks clean, Vite frontend bundle emitted. No partial Resources implementation existed on the interruption resume.

Notes retains its original fixed-folder read behavior, and Quick Notes retains its database, drafts and save semantics. Only presentation and a typed snapshot-store factory are shared; collection contents, in-flight requests and selection remain separate. The prior Notes-only milestone is recorded below as historical verification, not a claim of a second current test run.

The previously reported project-wide TypeScript unused `api` binding was removed and typecheck passed. The Tauri NSIS build ran its configured `npm run build` successfully; the full `npm run check` was not run in this continuation.

Resources rendered-source measurements passed at actual page widths approximately **358 px (Turkish)** and **1078 px (English)** with text-size 16: eight cards and source links, no page/card overflow and all toolbar controls within bounds. This is passive DOM/computed-layout evidence in Hermes's integrated preview, not screenshot, physical-interaction or native-filesystem acceptance. Interactive preview input was refused because the conversation was not the foreground session; no separate browser was opened.

## Decisions

- Windows Tauri is primary. Browser/Vite is an unsupported native-data preview, not a remote fallback.
- Read from the existing local Syncthing replica; do not add synchronization, background watchers, a VPS connection or Memory writer calls.
- Notes, Resources, To-Read and Someday are implemented at source level. No generalized collection configuration, other collections, editing, status changes or migration.
- Preserve existing Notes internals (`notes` mode, `TabsNotesDB`, persisted keys). New Memory mode is independent.
- Use existing installed dependencies and shared tokens/roles. No app-wide CSS redesign or dependency installation.

## Blockers and next step

Someday and the requested installed update are complete to the bounded checks above. Full project gate and unrelated provider/task workflows were not run. No Quick Notes migration or further collection is selected.

## Changed source

Someday continuation:
- `src/services/memorySomeday/` implements the fixed local root, one-level idea-folder boundary and focused native-boundary/reader/real-filesystem tests. It reuses the To-Read parser and bounded reader, filtering root files before discovery.
- `src/components/memorySomeday/`, `src/stores/memorySomedayStore.ts`, Memory navigation/workspace, shared page translation typing and English/Turkish catalogs add the separate page and component tests. No CSS, Rust, capability or dependency changes.

To-Read continuation:
- New `src/services/memoryToRead/{model,reader,desktop}.ts` and model/reader/native-boundary/real-filesystem tests. The reader is bounded to direct records and a single optional bundle level, with fixed Home/MOTHER/MEMORY/To-Read native scope.
- New `src/components/memoryToRead/MemoryToReadPage.tsx` and component/navigation regression tests, plus `src/stores/memoryToReadStore.ts`.
- `MemoryNotesNavigation.tsx`, `MemoryWorkspace.tsx`, `memoryNavigationStore.ts` and the shared page's translation-key type add the independent To-Read subpage. English/Turkish catalogs and naming checks updated. No shell-mode, CSS/token, dependency, Rust or permission changes.
- `src/services/memoryResources/model.ts` exports its existing safe-URL validator for To-Read reuse; Resources parsing behavior is unchanged.

Resources continuation:
- New `src/services/memoryResources/{model,reader,desktop}.ts` and their tests: source-aware metadata, bounded folder reader and fixed-root Tauri adapter.
- New `src/components/memoryResources/MemoryResourcesPage.tsx`, shared `src/components/memoryNotes/MemoryCollectionPage.tsx` and `MemoryWorkspace.tsx`, plus component/navigation regressions.
- New `src/stores/memoryResourcesStore.ts`, `memoryNavigationStore.ts` and `memoryCollectionStore.test.ts`; typed factory extracted in `memoryNotesStore.ts`. Notes parser/filter typing and snapshot issue typing extended without changing its read scope.
- Existing `MemoryNotesPage.tsx` delegates to shared presentation; `MemoryNotesNavigation.tsx` includes Resources; scoped CSS handles separate card-open/source-link targets. `AppLayout.tsx` routes Memory to its subpage switcher; both locale catalogs and naming checks updated.

Initial Notes delivery:

- `src/services/memoryNotes/{reader,model,desktop}.ts` and their focused tests, including a disposable real-filesystem fixture.
- `src/stores/memoryNotesStore.ts` and test: nonpersistent read-only snapshots, coalesced loads, explicit errors and last-known content on failed refresh.
- `src/components/memoryNotes/`: page, navigation, scoped CSS, UI regressions and bilingual naming checks.
- Shell integration: `src/App.tsx`, `src/components/header/ModeNavigation.tsx`, `src/components/layout/{AppLayout,LeftNarrowSidebar}.tsx`, `src/components/layout/workspace/ContextPanelToggle.tsx`, `src/stores/{uiStore,uiLayoutState}.ts`, and related routing tests.
- `src/services/clients/navigation.test.ts`: add the required Memory boolean to its existing shell-state fixture only.
- `src/i18n/{en,tr}.ts`: new Memory copy and existing Notes workspace label only; client notes retain their names.
- `src/styles/tokens.css`: one Notes card-width token; existing owner palette/geometry is preserved.

## Behavior and limits

- Uses the existing Tauri FS plugin with `BaseDirectory.Home` and fixed `MOTHER/MEMORY/Notes`. No new dependency, native command, capability or SSH route.
- Direct `.md` files only; management/hidden files and directories are not cards. Linked entries and conflict copies are not opened and receive a visible issue. No recursive sibling traversal or automatic conflict merging.
- Per-note read limit is 1 MiB. Partial read failures are visibly incomplete; root failure retains the previous snapshot explicitly stale. A refresh is not a Syncthing convergence check.
- Frontmatter reads simple scalar title/created/updated fields; unknown/invalid dates remain unknown. Files are never rewritten. Rendered Markdown does not execute raw HTML or load images; only explicit HTTP(S) links are clickable, and local/unsupported links remain text.
- The listing's link check is a read-time guard, not adversarial race isolation against a local process replacing a filesystem entry between operations.
- No Memory content is persisted in Dexie or fed into AI context. Existing Quick Notes drafts, ordering, categories and save/delete actions remain unchanged.

Resources-specific limits:
- The adapter uses fixed `Home/MOTHER/MEMORY/Resources`; only discovery/revalidation of fixed ancestors may list their immediate names. No sibling record content is read, and no selected path is supplied by the renderer.
- Full Resources-relative paths identify cards, including duplicate basenames across categories. The first folder is the category; direct root records are Uncategorized.
- Traversal is bounded to root → category → optional item bundle. One unambiguous nonmanagement Markdown record may be opened in a bundle; assets/images/attachments are not scanned. Unsupported/ambiguous bundles and per-item failures are visible issues, never silently imported or merged.
- Source buttons use only declared scalar metadata, source labels or source sections; incidental body/code URLs are not promoted. Unsafe schemes, control characters and credential-bearing URLs are rejected. No link is fetched merely to display a card.
- Parent/leaf directory-entry checks reject known symlinks before stat/read; `stat` alone follows links and is not a no-follow guarantee. Concurrent pathname replacement / Windows reparse limitations remain explicitly outside adversarial atomic isolation.

## Earlier Notes verification

- **PASS:** `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage" npm run test -- src/services/memoryNotes src/stores/memoryNotesStore.test.ts src/components/memoryNotes src/stores/uiStore.memory.test.ts src/stores/uiStore.notes.test.ts src/stores/uiStore.providerAccounts.test.ts src/stores/uiStore.settings.test.ts src/stores/uiStore.retiredMode.test.ts src/stores/uiLayoutState.test.ts src/components/header/ModeNavigation.test.tsx src/components/layout/LeftNarrowSidebar.test.tsx src/components/notes/NotesPage.test.tsx src/stores/notesStore.test.ts src/stores/workspaceStore.openFile.test.ts src/services/clients/navigation.test.ts` — **19 files, 109 tests passed**.
- **PASS:** `node node_modules/eslint/bin/eslint.js` with all touched TypeScript/TSX paths, including the Clients navigation fixture. No warnings/errors.
- **PASS:** scoped `git diff --check`.
- **FAIL (unrelated existing WIP):** `npm run typecheck` — only TS6133 in `ProviderAccountsPage.test.tsx:86` remains. Initial own errors (erasable-only constructor syntax and a missing Memory field in the Clients fixture) were corrected and rechecked.
- **PASS, bundling only:** `node node_modules/vite/bin/vite.js build` — 2767 modules transformed and `dist/` emitted. Existing large-chunk/ineffective-dynamic-import warnings remain. `npm run build` was gated by the failed typecheck and is not claimed passed.
- **PASS, synthetic rendered source:** actual Memory page and navigation mounted with eight clearly synthetic records and production CSS in the integrated preview. Approximately 358/898 px page widths, Turkish/English, text-size 16; no horizontal page overflow, toolbar bounds pass, input border 0 px, no rendered images. UI interactions/security/error states are exercised by the real-component tests; native/installed tests NOT RUN.
- Initial test-first runs failed on missing new modules; the filtering regression also observed a concrete assertion failure before correction. This is focused test-first/MVP evidence, not a blanket Strict TDD claim for every line.
- One `npx eslint` attempt timed out after tests passed; direct invocation of the already installed ESLint binary passed. Initial non-PTY preview launch exited with `stdin is not a tty`; the owned PTY fixture ran. A virtual-module React Refresh self-import failure was fixed in the scratch fixture, not production code.

## Resources verification

- **PASS:** `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage" npm run test -- src/services/memoryResources src/services/memoryNotes src/components/memoryNotes src/stores/memoryNotesStore.test.ts src/stores/memoryCollectionStore.test.ts src/stores/uiStore.memory.test.ts src/components/layout/LeftNarrowSidebar.test.tsx src/components/header/ModeNavigation.test.tsx src/components/notes/NotesPage.test.tsx src/stores/notesStore.test.ts` — **18 files, 90 tests**. This includes the child's 25 Resources model/reader/native-boundary tests and independent parent regression coverage.
- **PASS:** direct installed ESLint invocation across both Memory service/component directories, changed stores, AppLayout and both locale files. Scoped `git diff --check`, new-file whitespace and defined-CSS-token checks passed.
- **FAIL, unchanged unrelated error:** `npm run typecheck` — only `ProviderAccountsPage.test.tsx:86` TS6133 (`api` unused). No check was weakened or file excluded. The compound tool invocation subsequently ran lint successfully; its final exit 0 is not a typecheck pass.
- **PASS, bundling only:** `node node_modules/vite/bin/vite.js build` — 2775 modules transformed, emitted `dist/`, 15.75 seconds. Existing chunk-size and ineffective-dynamic-import warnings remain. This is not a passing `npm run build`/desktop build.
- **PASS, rendered source fixture:** Turkish narrow / English wide at text-size 16, page widths 357.818 / 1077.818 px, no card/page overflow, toolbar bounds pass, eight source links, zero rendered images. Fixture content is explicitly synthetic; it does not read the owner's Memory files. Actual category/search/detail/back/navigation and stale/error behavior are covered in React tests.
- **NOT RUN:** native Tauri filesystem/installed-app acceptance, installer packaging. No Rust/permission changes were made. The interrupted first preview process was found exited; only the owned scratch server was restarted for the completed measurements.

## To-Read verification

- **PASS:** `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage" npm run test -- src/services/memoryToRead src/services/memoryResources src/services/memoryNotes src/components/memoryToRead src/components/memoryNotes src/stores/memoryNotesStore.test.ts src/stores/memoryCollectionStore.test.ts src/stores/uiStore.memory.test.ts src/components/layout/LeftNarrowSidebar.test.tsx src/components/header/ModeNavigation.test.tsx src/components/notes/NotesPage.test.tsx src/stores/notesStore.test.ts` — **23 files / 110 tests**, final run 17.17 seconds.
- **PASS:** direct installed ESLint across new To-Read services/components, existing Memory components, the exported Resources validator, changed stores and both locale files; scoped diff and new-file whitespace checks also pass.
- **PASS, bundle only:** `node node_modules/vite/bin/vite.js build` — 2780 modules transformed, emitted `dist/`, 2.89 seconds. Existing large-chunk and ineffective-dynamic-import warnings remain.
- **FAIL, unrelated unchanged error:** project-wide `npm run typecheck` exits 2 with only `ProviderAccountsPage.test.tsx:86` TS6133 (`api` unused). It was not hidden, excluded or changed; this is not a full `npm run build` pass.
- New tests cover title/date/prose preservation, explicit and captured source URLs, ambiguous/unsafe originals, traversal/conflicts/symlinks, fixed root, no asset descent, before/after size limits, missing versus failed reads, late-response collection isolation, search/detail/back focus, and no marking-read/edit/delete/reminder action. A disposable real filesystem fixture under TMPDIR confirms original bytes/reading status and assets remain unchanged. Initial test-first runs failed because the new modules/store did not yet exist; no Strict TDD claim for every line.
- **NOT RUN:** new visual measurement, native Tauri/installed-app acceptance, packaging. Shared CSS was unchanged; the actual mounted To-Read route and interactions were exercised in component tests. No browser/test server or app process was launched by this continuation.

## Iterations

### 2026-10-31 — installed-app update

- Hermes Agent (openai-codex / gpt-6.1-terra): owner requested installation and explicitly approved the current source's possible legacy-chat deletion. No profile reset, remote administration or publication was authorized.
- `npm run typecheck` passed after removing one unused test binding; Accounts and isolated v22/legacy migration tests: 3 files / 18 passed. Touched-file ESLint and `cargo fmt --check` passed. Full `npm run check` not run.
- Archived and hash-checked the previous installed EXE, release EXE and both prior NSIS artifacts at `src-tauri/target/installer-archive/memory-update-20261031-061515/`. The preflight receipt captured 725 source input hashes; no captured input drift was detected before installation.
- Offline, locked local NSIS build with updater artifact creation disabled exited 0; configured `npm run build` ran, release x64 GUI PE confirmed. Installer SHA-256 `4484103000594393d346134c6f41b47480aa7be02feff24c6d27b927e56669fe`, 5348012 bytes; Authenticode `NotSigned`. Build log is in managed scratch `tabs-memory-update-20261031-build.log`.
- Generated installer confirms update mode avoids uninstallation and app-data deletion. Exact installer `/S /UPDATE` exited 0 for `C:/Users/burak/AppData/Local/TABS`; installed SHA-256 `79408c5f2bd02890f5d71cb91fa314967639b4a987135b70974d24ad76e1a204`. Installed and release EXEs match after exactly one expected NSIS-vs-unknown Tauri bundle marker substitution. Registry and Start-menu shortcut point to the installed target. Roaming/local profile directories retained their pre-install creation identities; this does not certify all stored records or prevent the approved migration.
- Installed process opened and responded. Memory pages loaded local Notes, Resources, To-Read and Someday records; a Someday detail opened. App left open on Someday. No model/provider, external links, full project gate or live task operations were tested.
- Initial native-window capture exposed a restored document containing apparent credentials to the agent tool; task-owned screenshot and element-tree files were removed. This does not erase prior tool output. Owner should rotate any exposed credentials; no values are recorded here.

### 2026-10-31 — Someday implementation and verification

- Hermes Agent (openai-codex / gpt-6.1-terra) continued the owner-selected workstream with Someday. Initial focused tests reported missing reader/desktop/store modules before implementation. A later project typecheck caught a new test mock tuple typing error; it was corrected and rerun.
- **PASS:** focused Memory and Quick Notes Vitest regressions: 27 files / 119 tests. **PASS:** scoped ESLint, Git diff whitespace check and new-source whitespace check. **PASS, bundle only:** `node node_modules/vite/bin/vite.js build`, 2784 modules; existing chunk and dynamic-import warnings remain.
- **FAIL:** `npm run typecheck`, only pre-existing `src/components/providerAccounts/ProviderAccountsPage.test.tsx:86` TS6133 (`api` unused). `npm run build` / full project gate were not passed. No desktop/native, live visual or installed-app validation was performed. No Memory record, task, reminder, dependency, capability, remote system or installed app was changed.

### 2026-10-29 — Hermes Agent (openai-codex / gpt-6-astra-900k)

- Read-only inspection of Notes, shell routing, filesystem services, dependencies and local Memory collection rules.
- Confirmed owner-selected development record and read-only Notes scope; no Memory record writes or remote operations.
- Checks: Git status/branch and relevant existing diffs read. Implementation verification NOT RUN yet.

### 2026-10-29 — implementation and verification

- Hermes parent implemented the read boundary, model, store, page, translations and isolated fixtures. A bounded Hermes subagent implemented shell routing only; its initially blocked sidebar check was rerun successfully by the parent after integration. Child model metadata was not reported and is not inferred.
- Final focused result: 109 passing tests, touched-file lint and diff checks clean; Vite bundle emitted. Project-wide typecheck retains one pre-existing Accounts-test error; native/installed acceptance remains open.
- No source commit/push, dependency installation, VPS access, Memory-record edit or Quick Notes migration. Scratch fixture files remain under the Hermes scratch directory; they are not production entrypoints.

### 2026-10-29 — Resources continuation

- Owner approved Resources next; retained this workstream record. Read collection/Tools guidance and two relevant source record formats without changing them; the local replica currently has a Tools category. No new Memory folders were created.
- Hermes parent added the shared presentation/store seams, Resources wrapper/navigation, bilingual copy and targeted regression tests. A bounded child owns only new `src/services/memoryResources/` model/reader/native adapter files and tests.
- Observed RED: missing shared store API and presentation module; missing Resources navigation button. GREEN: 10 files / 52 tests, covering independent late-result ownership, category/search combination, exact source links, detail/back focus, failed refresh and existing Notes/Quick Notes regressions. Parent touched-file ESLint passed.
- Integrated preview input was unavailable because this session was not the foreground session. No separate browser was opened; passive source measurements remain pending.

### 2026-10-29 — Resources integrated verification

- Reviewed all six child service/test files and verified their exact integration in the parent. The child model was not reported and is not inferred. Parent combined run: 90 passing tests, lint clean, frontend bundle emitted and source-layout measurements passed.
- Resources is complete at the source-delivery level. Preserve the separately reported project-wide Accounts-test blocker and unverified native/installed paths. No Memory-record write, import, migration, download, installation, new permission, commit, push or remote operation occurred.

### 2026-10-29 — To-Read implementation and verification

- Owner selected the next collection, To-Read. Hermes parent implemented and verified it without a delegate; reused existing layout/store factory and safe-source parsing rather than duplicating the UI or adding a general collection configurator.
- Final run: 110 passing focused tests, lint/whitespace clean and frontend bundle emitted. Existing project-wide Accounts-test blocker and native/installed acceptance limits remain explicit. No records, reading status, retention, reminders, dependencies, capabilities or installed apps were changed.
