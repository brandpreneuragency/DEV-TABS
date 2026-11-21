# TABS UI Rules

## Authority and maintenance

This is the single authoritative design-rule document for TABS. Every agent
creating UI from scratch, redesigning a screen, or changing UI styling must read
and follow it before designing or editing. The numbered sections match the simple
UI examples discussed with Burak, including his latest corrections.

- Apply rules by **role**, not by HTML tag. An action button, navigation item,
  text field, content card and calendar day are different roles.
- These rules take precedence over older UI guidance, historical builds,
  playground snapshots and conflicting existing CSS when designing new UI.
  Existing implementation is not evidence that a conflicting design is approved.
- **When Burak explicitly requests a rule change, update the affected rule in this
  file in the same task.** His request authorizes that document edit; do not refuse
  it because the previous rule says otherwise or ask for a second approval just
  to change the requested rule. Preserve unrelated rules and stable numbering.
- Update affected examples or implementation notes within the requested scope.
  Do not introduce a second independently maintained rulebook. A request to edit
  a rule alone does not authorize an application-wide CSS migration.
- If a requested value is unspecified, retain the existing value and state what
  remains undecided rather than inventing an approved value.
- Repository safety, runtime boundaries and verification requirements in
  [AGENTS.md](AGENTS.md) still apply.

## Where values and implementation live

| Purpose | File |
| --- | --- |
| Design rules and owner-requested rule changes | This file, `UI_RULES.md` |
| Editable colors, dimensions, typography and named-theme values | [`src/styles/tokens.css`](src/styles/tokens.css) |
| Shared CSS role implementations | [`src/styles/controls.css`](src/styles/controls.css) |
| Implementation map and verification notes | [`src/styles/README.md`](src/styles/README.md) |
| Feature-specific layout and justified special roles | The owning feature stylesheet |

Use existing token names, not another per-feature value catalog. `transparent`,
`none`, `auto`, `solid`, `0` and `currentColor` remain ordinary CSS values; do not
invent tokens for them. Fixed spacing is separate from resizable panel geometry
and the existing text-size settings.

**Implementation status:** this document defines the required design, not a claim
that every existing screen already implements it. Saving these rules does not
change production CSS. In particular, the approved new `--c-danger-2` token is not
currently defined in `tokens.css`; when implementing its use, define it there
first with the initial value `var(--c-danger)`. Its distinct hover color has not
yet been selected. Do not leave an undefined token reference in application CSS.

## 1. Icon and ordinary button

- UI icon width and height: `--c-icon-1`; stroke width: `--icon-stroke`.
- Icons follow the control foreground through `currentColor`, except deliberately
  semantic/status icons.
- Icon-only action: `--c-sq-button` square; padding and internal gap `0`.
- Text and icon + text action: height `--c-sq-button`, width `auto`, horizontal
  padding `--c-space-1`, icon/text gap `--c-gap-0`.
- Compact text action may use `--c-gap-1` horizontal padding.
- Border `none`; radius `--radius-sm`; shadow `none`.
- Do not make text buttons square or give content cards icon-button dimensions.

## 2. Ordinary button states

Ordinary button states follow the table below. App-shell panel visibility
toggles (left navigation, contextual panel and assistant) use the separate state
table after it: their pressed state means the panel is open.

| State | Background | Text / icon color |
| --- | --- | --- |
| Default | `transparent` | `--c-text-3` |
| Hover | `transparent` | `--c-text-1` |
| Selected / pressed, without hover | `transparent` | `--c-text-3` |
| Selected + hover | `transparent` | `--c-text-1` |

| Panel visibility toggle state | Background | Text / icon color |
| --- | --- | --- |
| Closed | `transparent` | `--c-text-2` |
| Open / pressed | `transparent` | `--c-text-3` |
| Hover, open or closed | `transparent` | `--c-text-1` |
| Focus, open or closed | `transparent` | `--c-text-1` |

- Ordinary button focus adds **no custom outline** and does not independently
  brighten text/icons. Panel visibility toggles follow their state table above.
  Keyboard activation and semantic focus must still work.
- Disabled: opacity `--disabled-opacity`, cursor `not-allowed`; no action and no
  hover treatment. `aria-disabled` alone does not prevent an action.
- Do not apply these quiet foreground/background rules to primary, danger,
  navigation, list-row or calendar-day roles that have their own rules below.
- Preserve native forced-colors/high-contrast focus indicators; the normal-mode
  outline removal is not permission to suppress system accessibility behavior.

## 3. Main navigation

Docs / Tasks / Calendar use a persistent selected surface, unlike Assistant.

| State | Background | Text / icon color |
| --- | --- | --- |
| Default | `transparent` | `--c-text-3` |
| Hover | `transparent` | `--c-text-1` |
| Selected | `--c-background-1` | `--c-text-1` |
| Selected + hover | `--c-background-1` | `--c-text-1` |

- Calendar uses `--c-background-1` when selected or hovered, including named themes.
- Height `--c-sq-button`; width `auto`; horizontal padding `--c-space-3`;
  icon/text gap `--c-space-0`; border `none`; radius `--radius-sm`.
- No custom button focus outline in normal rendering. Keyboard focus must not
  remove the selected surface. Forced-colors system focus is preserved.
- Hover is temporary pointer presence; selected identifies the active page.

## 4. Text input

- **No app-owned text input has a border in any state**, including default,
  hover, focus, disabled and inline title editing. Use `border: none`.
- Background `--c-background-3`, text `--c-text-1`, placeholder `--c-text-3`;
  hover and focus retain the same background.
- Focus outline `none`; no accent ring, glow or additional focus background.
- Standalone height `--control-height-sm`, horizontal padding `--c-space-1`,
  radius `--radius-sm`, font size `--fs-sm`.
- Focus must not change the field's dimensions or move neighboring content.
- Disabled uses `--disabled-opacity` and cannot accept edits.
- Special inline search geometry may remain compact; it is still borderless.
  Checkbox/radio and calendar-day geometry are separate roles, not text inputs.
- Memory collection toolbar search and select controls use `--c-sq-button`
  (currently 24px) for both height and minimum height, rather than standalone
  field height.

## 5. Comment / message composer

- The textarea background stays `transparent` in default, hover and focus states.
  The visible outer background belongs to the composer card, not a second field
  surface. Text uses `--c-text-1`, placeholder `--c-text-3`, font size `--fs-sm`.
- Textarea border, outline and shadow: `none`.
- Grow with content; preserve the owning composer's min/max height and resize
  behavior. Do not force standalone input height or form-textarea min-height.
- While focus is within the composer card, uses of `--c-text-3` inside the card
  resolve to `--c-text-2`, an existing card border uses `--c-border-2`, and
  the resize grip uses `--c-text-2`. Other colors and borderless cards stay
  unchanged. Attach and Send remain separate controls.
- Empty/sending states prevent invalid repeated sends; sending prevents edits as
  required by the existing workflow. Styling does not change sending behavior.

## 6. Typography and text color

- Chrome font: `--c-font-1`; labels/controls: `--fs-sm` and `--lh-sm`;
  small metadata: `--fs-xs`.
- Normal chrome labels and metadata: `--c-text-3`; content/input text:
  `--c-text-1`; existing secondary emphasis may use `--c-text-2`.
- Hover brightens ordinary controls. Selected navigation remains bright;
  selected ordinary buttons do not, as defined in section 2.
- Ordinary labels do not become accent-colored merely because they are hovered,
  focused or selected.
- Document navigation Clear uses `--c-text-3` at rest and `--c-text-1` on hover.
  Connect Folder, editor topbar controls and title use `--c-text-2` at rest and
  `--c-text-1` on hover.
- Chat history and New chat use `--c-text-3` at rest and `--c-text-1` on hover.
- The calendar toolbar, project toolbar actions and project column headers, and
  Notes search, New note and Manage categories use `--c-text-2` at rest and
  `--c-text-1` on hover. Notes search input text remains `--c-text-1`.
- Semantic feedback retains `--c-danger`, `--c-warning`, `--c-success` and
  `--c-info`. Danger-action hover has its separate token in section 13.
- Accent can identify deliberate data cues, Today labels, checks/status indicators
  and drag insertion lines; it is not a generic decorative border color.
- Preserve authored document colors, code/syntax highlighting, client/category
  colors and authored embedded-form design. They are not chrome labels.
- Preserve existing supported text-size behavior; do not flatten all text to one
  fixed font size.

## 7. Panel and page structure

- Shell: `--c-background-4`; main panel: `--c-background-2`;
  toolbar/composer-card surface: `--c-background-3`.
- Standard content inset: `--c-space-1`, owned by one layer. Do not repeat the
  same inset on a wrapper and its inner body around the same content.
- Notes keeps its outer page unpadded; its inner grid owns the standard inset.
- Memory collection pages (`.memory-notes-page`) use `--c-background-3`
  instead of the standard main-panel surface; their outer page stays unpadded.
- Give each scroll region one owner. Preserve `min-width: 0`, `min-height: 0`
  and correct overflow ownership in nested flex/grid layouts.
- Scrollbar thumb uses `--c-border-0` at rest and `--c-border-1` on hover;
  its track is transparent.
- Keep `--editor-inset`, tree depth, card metadata layout and user-resized panel
  widths separate from generic content padding. Preserve `--shell-handle-width`.
- Do not automatically add borders to panel roots or create a competing shell.
  Reuse `PrimaryWorkspaceContent` / `CenterContentPanel`.
- Preserve editor, form and chat identity/state when panels open, close or swap.

## 8. Toolbar

- Toolbar height: `--control-height-sm`; child actions: `--c-sq-button`, centered
  vertically. Children do not inherit the toolbar's full height.
- Background `--c-background-3`; bounded toolbar border:
  `var(--border-width) solid var(--c-border-1)`; radius `--radius-sm`.
- Horizontal padding `--c-space-0`; regular gap `--c-gap-1`;
  compact-cluster gap `--c-gap-0`.
- Routine actions follow sections 1–2, with transparent backgrounds.
- Memory collection toolbar wrapper padding is `0` top and `--c-space-0` (6px)
  horizontally and bottom.
  Their bounded toolbar grows with wrapped controls; search and selects use the
  compact height in section 4.
- In narrow layouts retain the primary action. Wrap or use the existing overflow
  menu; do not clip wrapped controls inside a fixed single-line height.

## 9. Navigation / tree row

- Default: transparent background and `--c-text-3`; hover: transparent background
  and `--c-text-1`.
- Selected and selected + hover: `--c-background-1` with `--c-text-1`.
- Minimum height `--control-height-sm`; full container width; content may grow.
  Vertical padding `--c-gap-1`, horizontal padding `--c-space-1`, internal gap
  `--c-space-0`, radius `--radius-sm`, border `none`.
- Preserve tree indentation separately. A tree depth is not generic panel padding.
- List-row keyboard focus is a separate role from ordinary button focus: retain
  its `--focus-width` solid `--c-border-2` inward outline and selected surface.
- Necessary secondary actions must be reachable by keyboard/touch, not only
  mouse hover. A danger action does not turn its whole row danger-colored.

## 10. Task card

- Default: transparent surface and `--c-text-3` title; hover brightens the title
  to `--c-text-1` without adding a background.
- Selected and selected + hover: `--c-background-1` with `--c-text-1` title.
- Padding `--c-space-2`, internal gap `--c-space-1`, radius `--radius-sm`;
  border/shadow `none`; height follows content.
- Client/project breadcrumb and due-date metadata use `--c-text-3` at `--fs-xs`
  by default and `--c-text-2` when the card is hovered or selected.
- Show the completion action on the selected card only while that card is
  hovered or keyboard-focused; keep it visible on the selected card for
  hoverless/touch devices. Never reveal it on passive-card hover. When the
  action is hidden, show the due date, including for completed tasks. The action
  uses `--c-text-2` at rest and `--c-text-1` on hover.
- Archived task cards follow the same default, hover, selected and keyboard-focus
  appearance as regular task cards, without a persistent completion marker or
  line-through. Preserve transient completion feedback without shadows.
- Opening a card and completing it are separate actions. Keep completion
  keyboard/touch-accessible and prevent repeated status writes while saving.
- Preserve the card-opening control's role-specific keyboard focus treatment;
  do not infer square button geometry from its HTML tag.

## 11. Calendar

- Day surface `--c-background-3`; no automatic day-hover surface change.
- Today label `--c-accent-1`; no extra accent perimeter or glow around the day.
- Outside-month label `--c-text-3`; do not reduce the opacity of the entire column
  or its cards. Do not invent a separate weekend palette.
- Empty-state text `--c-text-3`, transparent background.
- Default task-card surface `--c-background-2a`, title `--c-text-1`, metadata
  `--c-text-3`; padding `--c-space-2`, internal gap `--c-space-0`, radius
  `--radius-sm`; border/shadow `none`.
- The active task card uses `--c-background-2` and a
  `var(--border-width) solid var(--c-border-1)` border. Keep this surface when
  hovered; do not add a shadow.
- A card-menu icon follows ordinary icon-button rules. Opening its popup does not
  itself select the card.

## 12. Menu / dropdown / popover

- Surface `--c-background-2`, container text `--c-text-1`, border
  `var(--border-width) solid var(--c-border-1)`, radius `--radius-sm`;
  container padding and row gap `--c-gap-1`; no shadow.
- Rows follow section 9: minimum height `--control-height-sm`, quiet default and
  hover, persistent selected surface, role-specific keyboard focus.
- Semantic menu actions retain their own colors; generic hover does not erase
  danger/success meaning. Danger-action hover uses section 13.
- Open popup state does not automatically add accent fill/border to its trigger.
- Style a portaled overlay from its actual root, including search, rows, footer
  and scroll state. Do not rely on a former parent selector.
- Preserve keyboard navigation, Escape/outside dismissal and focus restoration.
  Repositioning or scrolling must not steal focus from the chosen item.
- Use the existing role-appropriate `--z-dropdown` / `--z-modal` layers.

## 13. Send, New and danger actions

| Role | Default background / text | Hover background / text |
| --- | --- | --- |
| Genuine primary / Send | `--c-accent-2` / `--c-text-1` | `--c-accent-1` / `--c-text-1` |
| Routine New / Add / More | `transparent` / `--c-text-3` | `transparent` / `--c-text-1` |
| Quiet danger / Delete | `transparent` / `--c-danger` | `transparent` / `--c-danger-2` |

- `--c-danger-2` is the approved separate danger-hover token. Until Burak chooses
  a distinct color, its initial value is `var(--c-danger)`, not an invented red.
  Define it in `tokens.css` when implementing this rule; see implementation status
  above. It is not a replacement for ordinary error/feedback text.
- Routine actions do not become filled primary buttons merely because they are
  important. Existing class names such as “primary” do not overrule their role.
- Send keeps its readable `--c-text-1` foreground, ordinary icon geometry,
  border `none` and existing round shape using `--radius-full` where applicable.
- Disabled actions cannot run or acquire hover treatment. Ordinary custom button
  focus outlines remain absent; preserve forced-colors system indicators.

## 14. Date picker and segmented selection

- Popup container follows section 12.
- Default day: transparent / `--c-text-1`; hover: `--c-accent-2a` / `--c-text-1`.
- Selected and selected + hover: `--c-accent-2` / `--c-text-1`.
- Outside-month day foreground: `--c-text-3`.
- Day cells have special geometry; do not force `--c-sq-button` square dimensions.
- Preserve date-cell keyboard focus and selection together: the role-specific
  inward outline may use `--focus-width` and `--c-border-2`. Do not invent an
  additional Today ring/color treatment.
- Week/month segmented controls use quiet default/hover and the persistent
  selected-navigation surface from section 3. Hover must not clear selection.

## 15. Form textarea and editable title

- **App-owned text inputs and textareas are borderless in every state**, including
  standalone fields, inline rename/title fields, form textareas and composer
  textareas. The Scripts editor is the named exception: its name, description,
  code and runtime controls (`.scripts-editor .ui-input`) use a 1px solid
  `--c-border-1` border.
- Normal-mode field focus outline `none`; hover/focus do not change background.
  Preserve system forced-colors indicators and editable caret behavior.
- Form textarea: `--c-background-3`, text `--c-text-1`, placeholder `--c-text-3`,
  padding `--c-space-1`, radius `--radius-sm`, minimum height
  `--composer-min-height`; height follows rows/content. Composer remains the
  separate transparent-textarea role from section 5.
- Editable title: left-aligned, transparent, full available width, with truncation
  for long titles. It is not a centered CTA. Its edit-mode input is also borderless.
- The Notes card title input uses `--fs-base` while editing.
- Preserve the actual rename/save/cancel workflow; styling alone is not evidence
  that a rename or save worked.

## 16. Flat design, borders and spacing

- No app-owned box shadows, text shadows, drop-shadow, glow, decorative gradients
  or blur. This includes themes, menus, dialogs, completion effects and drag
  previews. Remove generating declarations instead of masking them globally.
- Resize handle lines use `--c-border-0` by default, including composer grips
  and reusable page separators. Composer grips use `--c-border-2` on hover;
  their focused color remains `--c-text-2`.
- Exception: navigation, main and contextual panel resize lines are 2px wide
  (`--c-gap-0`). Only handle hover
  applies `--c-accent-2` background and a
  `0 0 var(--c-gap-2) var(--c-accent-2)` glow to the line. Focus alone does not
  activate this effect; preserve the existing drag hit areas.
- Borders remain allowed for appropriate containers/toolbars/popovers, but not
  text inputs or textareas except for the Scripts editor controls documented in
  section 15. Visible app-owned borders use existing `--c-border-1` /
  `--c-border-2`, except resize grips as specified above; do not use decorative
  accent/status perimeters.
- `--c-border` is not currently defined; do not invent or reference it implicitly.
- Normal bounded-container border uses `--border-width` and `--c-border-1`.
  Role-specific focus/drop outlines use `--c-border-2` where explicitly retained.
- Border and outline are different properties. Focus must not alter layout size.
- Fixed spacing: compact gap `--c-gap-0`, regular small gap `--c-gap-1`, content
  inset `--c-space-1`. Do not add viewport-dependent spacing clamps.
- Preserve tree depth, document formatting, metadata geometry and user-resized
  panel widths instead of flattening them with a generic spacing reset.

## 17. Drag, keyboard behavior and themes

- Drag source uses `--drag-source-opacity`, `--drag-source-scale`,
  `--drag-duration` and `--drag-ease`; no drag-preview shadow.
- Insertion marker `--c-accent-1`; retained drop outline `--c-border-2`.
  Remove insertion markers/highlights on target exit, target change and drag end.
- Preserve native payload, drop owner and insertion placement behavior. Visual
  styling does not authorize a task/document behavior change.
- Give icon-only actions accessible names. Required actions remain reachable by
  keyboard/touch; removing a custom outline does not disable keyboard behavior.
- Preserve reduced motion and native forced-colors focus behavior.
- Default and named themes share the role/state rules. Preserve explicit named
  theme palette/surface/radius differences unless Burak requests their change.

## 18. Special roles are not ordinary buttons

Preserve role-specific geometry and authored styling unless explicitly changed:

- Checkbox/radio, color swatches, calendar day/weekday cells and window controls.
- Titlebar window controls are 36px wide (`--window-control-width`) and 24px
  tall (`--c-sq-button`), with matching fixed flex basis, zero minimum sizes
  and no maximum-size constraints. Their container uses automatic width and
  zero minimum width/height.
- App titlebar close control: `--c-danger` icon at rest; `--c-danger` background
  and `--c-text-1` icon on hover/focus. Preserve window-control geometry.
- Tree indentation and document/prose formatting.
- Composer min/max height, resize grip and content-specific spacing.
- Calendar active/completed/hover surfaces and task completion treatment.
- Authored document/code colors, user client/category colors and embedded-form
  design, distinct from application-owned editable field chrome.
- Existing named-theme surface/radius differences and touch-specific hit targets.

A shared HTML tag is not permission to standardize these roles to one square
button. Conversely, special geometry is **not** an exception to the app-owned
text-input/textarea border ban. Changing a special role requires an explicit
role/value decision, recorded in this document when requested.
