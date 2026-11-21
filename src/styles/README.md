# TABS styles — implementation guide

**The design authority is [`UI_RULES.md`](../../UI_RULES.md) at the repository
root. Read it before designing or changing UI.** This file maps implementation
locations; it is not a second design-rule source. Owner-requested rule changes
belong in the root document, not in a competing local rule list.

Current CSS may predate the latest design decisions. Inspect the actual cascade
and existing owner edits, but do not treat an older implementation or build as
permission to override `UI_RULES.md`. A documentation update is not proof of an
implemented or installed-app migration.

## Implementation locations

| Purpose | Location |
| --- | --- |
| All editable design values, including named themes | [`tokens.css`](./tokens.css) |
| Shared control/container recipes | [`controls.css`](./controls.css) |
| Named-theme surface recipes | [`purpleNeon.css`](./purpleNeon.css) |
| Drag visual treatment | [`dragMotion.css`](./dragMotion.css) |
| Feature placement/layout and special-role implementation | The owning component stylesheet |

Keep role decisions in `UI_RULES.md`, values in `tokens.css`, shared application
rules in `controls.css`, and structural layout with its feature. Implement an
approved new token before using it; the root document identifies any pending
addition. Do not silently add another token catalog.

## Shared-role map

| Role | Existing implementation entry |
| --- | --- |
| UI icon | Lucide / `ui-icon` / `icon-base` selectors |
| Ordinary icon-only action | `ui-icon-button` |
| Text or icon + text action | `ui-button` |
| Compact or round action shape | `ui-button--compact` / `ui-button--round` |
| Primary, danger or quiet action variant | `ui-button--primary` / `ui-button--danger` / `ui-button--ghost` |
| Toolbar | `ui-toolbar` |
| Standalone editable field or form textarea | `ui-input` |
| Selectable list row | `ui-list-row` |
| Content card | `ui-card` |
| Page / panel content owner | `ui-page-body` / `ui-panel-body` |
| Label + control | `ui-field` |

Use the role's current rule from `UI_RULES.md`, not its HTML tag or modifier name,
to decide dimensions, colors and state behavior. Inspect min/max sizes and flex
basis as well as local declarations when preserving a special role.

For mounted workspace layout, reuse the existing `PrimaryWorkspaceContent` /
`CenterContentPanel` path. For overlays, inspect their actual mounted/portaled
root and descendants; closed-screen source inspection does not verify the menu.

## Retired personal overrides

Appearance retains theme selection, not a token editor. On startup, `themeTokens`
is archived verbatim to a unique `legacy.themeTokens.v1.*` recovery key before the
active key is removed in the same transaction. Failure preserves the original.
Archived overrides are not applied; documents and task data are not migrated.

## Verification

Run relevant tests, including `npm run test -- src/styles/designTokens.test.ts`.
These check the implementation: fixed values, single-source definitions,
retired/undefined tokens, shared roles and absence of shadow effects. When an
implementation task changes an approved rule, update its focused regression
checks to the root contract rather than treating old assertions as design
authority. Do not weaken unrelated verification. Drag-preview checks must still
protect payloads and original styling.

Source checks do not prove the cascade. Inspect computed sizes/colors, real hover
and role-specific keyboard behavior, both themes, opened overlays, supported text
sizes and narrow layouts. Report browser preview separately from native
Tauri/installed-app verification. Never infer authorship from file timestamps or
classify every dirty-worktree difference as a new owner change.
