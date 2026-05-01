# Keyboard Shortcuts System

Hubris now has a frontend command system with stable command IDs, typed
arguments, command palette integration, command-owned dialogs, and contextual
availability. I want a VS Code-style keyboard shortcuts layer on top of that
system so common actions can be invoked quickly without duplicating action logic
outside commands.

## Goal

Create a reusable frontend keyboard shortcuts system that maps keybindings to
existing command IDs, optional command arguments, and optional contextual `when`
conditions.

## Scope

- Focus on frontend shortcut definition, resolution, display, and execution.
- Build on the existing frontend command system rather than creating a parallel
  action model.
- Support app-level default keybindings for common Hubris actions.
- Persist user keybinding overrides in a hand-editable `keybindings.toml` file.
- Support contextual shortcuts that only apply when the current UI state matches
  a condition.
- Include enough condition/context infrastructure for current Hubris needs and
  future extension.
- Keep the first version practical; do not turn this into a full VS Code
  settings editor unless that naturally falls out of the existing settings
  architecture.

## Desired Outcome

- Hubris has one central place where keyboard shortcuts are defined and
  inspected.
- A keybinding can target any command by stable command ID.
- A keybinding can pass serializable command arguments.
- A keybinding can include an optional `when` condition that is evaluated
  against current frontend context.
- Keyboard shortcuts execute commands through the existing command runtime.
- UI surfaces that show commands can also show their assigned shortcut where it
  is useful.
- Shortcut handling respects text input, dialogs, terminal focus, browser tabs,
  editor focus, and other focused interactive surfaces.
- Conflicts and unavailable commands fail predictably instead of silently
  triggering surprising actions.
- Users can edit `keybindings.toml` by hand, including comments, without Hubris
  destroying formatting or unrelated entries when it writes updates.

## Keybinding Model

Use a data shape conceptually similar to VS Code:

```ts
{
  key: "cmd+shift+p",
  command: "app.openCommandPalette",
  args?: { ... },
  when?: "selectedWorktree && !inputFocus",
}
```

The exact names and types should follow Hubris conventions, but the model should
preserve those core concepts:

- `key`: human-authored keyboard sequence or chord.
- `command`: existing command ID.
- `args`: optional serializable command arguments.
- `when`: optional condition expression evaluated against frontend context.

## `keybindings.toml`

Persist user keybinding overrides in a `keybindings.toml` file, following the
same hand-editable philosophy as `settings.toml`.

Use TOML because it supports comments and is comfortable to edit directly. The
exact schema should be chosen during implementation, but it should be easy to
read and write by hand. A shape like this would be reasonable:

```toml
# Open the command palette.
[[keybindings]]
key = "cmd+shift+p"
command = "app.openCommandPalette"

[[keybindings]]
key = "cmd+t"
command = "tab.newTerminal"
when = "selectedWorktree && !inputFocus"

[[keybindings]]
key = "cmd+alt+b"
command = "tab.newBrowser"
args = { url = "http://localhost:5173" }
when = "selectedWorktree"
```

Requirements for the file:

- Store user overrides separately from built-in defaults.
- Preserve comments, unknown keys, and existing formatting where practical when
  Hubris writes changes.
- Use a `toml_edit`-style document-preserving approach like `settings.toml`
  instead of parse-and-rewrite serialization that destroys comments.
- Watch or reload the file in the same spirit as settings so hand edits can take
  effect without restarting when practical.
- Treat malformed TOML as a visible configuration error while keeping the last
  good keybinding snapshot active.
- Block writes or avoid clobbering the file while it is malformed, matching the
  safety behavior used for invalid `settings.toml`.
- Keep default keybindings available when the file is absent.
- Define how user bindings add, override, or disable default bindings.
- Keep the schema stable enough for users to maintain manually.

## Requirements

- Shortcut definitions must reference existing command IDs instead of embedding
  action callbacks.
- Shortcut execution must go through the same command runtime used by the
  command palette, buttons, menus, context menus, and dialogs.
- Shortcut definitions must support optional command arguments.
- Shortcut definitions must support optional `when` conditions.
- The condition model must cover at least:
  - selected project/worktree presence
  - active tab type
  - focused pane presence
  - command palette/dialog open state
  - text input or editable element focus
  - terminal focus
  - browser tab focus
  - Monaco/file editor focus
  - git status/sidebar focus where relevant
- The condition evaluator should be deterministic, testable, and small enough to
  understand without a large parser framework unless a dependency is clearly
  justified.
- Key normalization must handle platform differences, especially `Meta` on macOS
  and `Ctrl` elsewhere.
- Display labels should use platform-appropriate modifier names and symbols
  where Hubris already uses that style.
- Shortcut lookup must be order-independent where possible, with explicit
  precedence rules when multiple bindings match the same key event.
- More specific contextual shortcuts should be able to override broader global
  shortcuts.
- Disabled or currently unavailable commands should not execute from keyboard
  shortcuts; preserve the existing command availability behavior.
- Browser/system-reserved shortcuts should not be intercepted unless the app
  already owns that interaction and there is a clear product reason.
- Shortcut handling must avoid breaking normal typing, text selection, IME
  composition, accessibility interactions, and native form controls.
- Shortcut handling must work in both web and desktop modes.
- User keybinding overrides must be loaded from `keybindings.toml` and merged
  with built-in defaults deterministically.
- The backend or frontend boundary for keybinding persistence should fit the
  existing settings architecture; do not invent a second persistence pattern
  without a clear reason.

## Integration Requirements

- Reuse `apps/web/src/lib/commands/` for command IDs, context snapshots, command
  execution, and availability.
- Extend the command context only when keyboard conditions need data that is not
  already represented.
- Prefer a focused keyboard shortcut module under `apps/web/src/lib/` or
  `apps/web/src/lib/commands/` over scattering `keydown` handlers through leaf
  components.
- Route command palette opening through a command so it can be triggered by the
  same shortcut system as other actions.
- Replace existing ad hoc app-level shortcut handling where it overlaps with the
  new system.
- Keep shadcn vendor files under `apps/web/src/components/ui/` untouched unless
  there is no reasonable app-level alternative.
- Keep state in existing Zustand stores or narrowly scoped new stores when the
  shortcut layer needs shared state.
- Persist `keybindings.toml` in the same data directory family as
  `settings.toml`, with the exact dev/prod paths following existing app
  conventions.
- If backend APIs are needed for loading, saving, validation, or file status,
  model them like settings APIs and feed frontend state through the existing
  REST/SSE patterns.
- Do not add polling for shortcut behavior; if file-backed keybindings need live
  status, reuse settings-style file watching or the existing app-wide state sync
  model.

## Default Shortcuts

Include a sensible initial set of default shortcuts for common actions. Exact
bindings can be adjusted during implementation, but the feature should cover
actions in these categories:

- Open command palette.
- Open settings.
- Create terminal tab.
- Create browser tab.
- Close active tab.
- Pin or unpin active tab.
- Split pane right/down.
- Switch or focus tabs where current tab state makes that practical.
- Toggle or focus major app regions where Hubris already has a clear action.

Avoid over-assigning shortcuts in the first pass. Prefer fewer reliable,
discoverable shortcuts over a large set with conflicts or weak context rules.

## Condition Guidance

- Treat `when` conditions as product-facing configuration, not arbitrary
  JavaScript.
- Keep the supported expression language intentionally small.
- Boolean identifiers and simple boolean operators are enough for the first
  version if they cover current needs.
- Prefer named context keys like `terminalFocus`, `editorFocus`, `inputFocus`,
  `commandPaletteOpen`, `selectedWorktree`, and `activeTabType == 'terminal'`
  over component-specific implementation details.
- Make it easy to add new context keys without rewriting existing conditions.
- Conditions should be evaluated from a fresh context snapshot at keydown time.
- Missing or unknown condition keys should produce an explicit failure in tests
  or development, not silently behave as false in a way that hides typos.

## Conflict Guidance

- Define how duplicate keybindings are handled.
- Define how global shortcuts interact with contextual shortcuts.
- Define how shortcuts behave when multiple matching bindings are available but
  only one command is currently enabled.
- Make conflicts visible to developers through tests, assertions, warnings, or a
  debug helper.
- Do not let random registration order decide user-visible behavior.

## UI Guidance

- Show shortcuts next to command labels where the existing UI has a natural
  shortcut slot, such as command palette items or menu entries.
- Keep shortcut labels compact and platform-appropriate.
- Avoid adding explanatory in-app text solely to describe the feature.
- If shortcut hints are shown in menus or command rows, source them from the
  keybinding registry instead of hardcoding display strings at call sites.

## Important Constraints

- Do not duplicate command behavior in shortcut handlers.
- Do not put command-specific `keydown` listeners in individual leaf components
  when the shortcut can be represented in the central keybinding system.
- Do not intercept keyboard events inside terminals, Monaco editors, browser
  iframes/views, or input fields unless the shortcut is explicitly meant to work
  there.
- Do not require a backend migration for the first version unless user-owned
  persisted keybindings become part of the chosen implementation.
- Do not introduce a large dependency for basic key parsing or boolean
  conditions if the required behavior is small.
- Keep React patterns aligned with current project guidance, especially avoiding
  unnecessary `useEffect` orchestration in leaf UI components.

## Relevant Existing Code

- `apps/web/src/lib/commands/`
- `apps/web/src/components/commands/CommandPalette.tsx`
- `apps/web/src/components/commands/CommandDialogs.tsx`
- `apps/web/src/lib/stores/commandUi.ts`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/stores/projects.ts`
- `apps/web/src/lib/stores/worktrees.ts`
- `apps/server/src/settings_manager.rs`
- `apps/server/src/state.rs`
- `apps/web/src/App.tsx`
- `apps/web/src/components/WorktreeView.tsx`
- `apps/web/src/components/TabBar.tsx`
- `apps/web/src/components/TerminalTab.tsx`
- `apps/web/src/components/BrowserTab.tsx`
- `apps/web/src/components/FileEditorTab.tsx`
- `docs/prompts/frontend-command-system.md`
- `docs/agents/backend.md`
- `docs/agents/frontend.md`
- `docs/agents/architecture.md`

## Design Guidance

- Start from the command system as the source of truth. Keyboard shortcuts are a
  dispatch layer, not a second place to define behavior.
- Match VS Code’s useful concepts without copying its full complexity.
- Bias toward clear, typed data structures that are easy to inspect in tests.
- Make focus/context behavior boring and explicit; this is where keyboard
  shortcut systems tend to become surprising.
- Keep the first version extensible enough for future user-configurable
  keybindings UI, but do not let that UI dominate the core file-backed model.
- Treat the TOML file as a user-owned artifact. Automated writes should be
  careful, minimal, and comment-preserving.

## Deliverables

- Central keyboard shortcuts/keybindings registry
- Key parsing, normalization, matching, and display helpers
- `when` condition context and evaluator
- `keybindings.toml` loading, validation, merge, and save behavior
- Comment-preserving TOML update path for user keybinding changes
- App-level keyboard event integration
- Command execution through existing command runtime
- Initial default shortcuts for common Hubris actions
- Shortcut labels in relevant command/menu UI surfaces
- Tests covering key parsing, condition evaluation, conflict behavior, command
  dispatch, focus guards, and representative UI integration
- Tests covering `keybindings.toml` parse errors, comment preservation, default
  merging, override behavior, and malformed-file safety

## Verification

- Verify default shortcuts trigger the same commands as palette/menu/button
  paths.
- Verify shortcuts do not fire while typing in normal inputs.
- Verify terminal, editor, browser, dialog, and command palette focus cases are
  handled intentionally.
- Verify contextual shortcuts only apply when their `when` condition matches.
- Verify conflict handling is deterministic.
- Verify `keybindings.toml` comments survive a Hubris write.
- Verify invalid `keybindings.toml` surfaces an error and keeps the last good
  keybinding snapshot active.
- Run the relevant frontend tests you touch, then finish with:

```sh
mise run check
```
