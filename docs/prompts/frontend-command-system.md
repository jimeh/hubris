# Frontend Command System

Hubris has accumulated many user actions that are currently wired directly into
individual buttons, menus, dialogs, and view components. I want a first-class
frontend command system so those actions can be defined once as named commands,
invoked consistently from a command palette and other UI entry points, and
prepared for a later keyboard-shortcut layer.

## Goal

Create a reusable frontend command system with named commands, structured
arguments, and command palette integration, then migrate most existing UI
actions onto that system.

## Scope

- Focus on frontend command definition, discovery, and invocation.
- Include command palette support and programmatic command execution from UI
  surfaces.
- Treat keyboard shortcuts as a future consumer of this system, but do not
  implement the shortcut system itself in this task.
- Cover existing user actions that already exist in Hubris’s UI and would
  benefit from being normalized as commands.

## Desired Outcome

- Hubris has a first-class registry of named frontend commands.
- Commands can be executed from a command palette.
- Commands can also be executed by buttons, menus, context menus, and other UI
  elements without duplicating action logic at each call site.
- Commands can accept optional structured arguments so the same command can be
  reused in multiple contexts.
- The system reduces action-specific orchestration embedded in leaf UI
  components.
- The result is a solid base for a future VS Code-style keybinding layer.

## Requirements

- Commands must have stable names/IDs suitable for referencing from multiple
  frontend surfaces.
- Commands must support user-facing metadata appropriate for palette-style
  discovery.
- Commands must support input arguments, including optional arguments.
- The same command must be invokable both:
  - directly from the command palette
  - programmatically from existing UI surfaces with explicit arguments/context
- Commands should be usable for most current user actions across the app,
  especially actions related to projects, worktrees, tabs, panes, browser tabs,
  and other common worktree interactions.
- A command should be able to derive behavior from current frontend context when
  appropriate, while still allowing explicit arguments to override that context.
- Commands should have a clear story for availability and failure handling so
  invalid or currently unavailable actions do not silently misfire.
- The command system should make it easier to centralize action labels and
  behavior instead of scattering them across unrelated components.
- The design must leave room for a later shortcut layer that references command
  names plus optional arguments/conditions.

## Integration Requirements

- Reuse Hubris’s current frontend architecture rather than creating a parallel
  state model.
- Keep backend-authoritative behavior backend-authoritative: commands that
  perform mutations should continue to flow through the existing REST and SSE
  architecture where appropriate.
- Prefer shared frontend state in dedicated Zustand stores or focused app-level
  modules rather than local component orchestration.
- Do not regress existing interactions while migrating actions onto commands.
- Keep the command palette and command execution model coherent in both web and
  desktop modes.

## Important Constraints

- Avoid turning this into a heavyweight plugin/extension framework unless that
  is clearly justified by current needs.
- Avoid baking keyboard shortcut logic directly into the command system.
- Avoid pushing command behavior down into vendor-managed shadcn files under
  `apps/web/src/components/ui/`.
- Avoid a design that requires leaf components to own duplicated business logic
  just to trigger common actions.
- Keep React patterns aligned with current project guidance, especially around
  avoiding unnecessary `useEffect` orchestration.

## Examples of Desired Capability

- A `new-worktree` command can be invoked from the command palette with no
  initial arguments, or from a project-specific UI surface with a project ID
  already supplied.
- A tab or pane action can be exposed both in a context menu and in the command
  palette while still reusing the same underlying command behavior.
- Future keyboard shortcuts should be able to target the same command names
  without redefining action semantics.

## Relevant Existing Code

- `apps/web/src/components/WorktreeView.tsx`
- `apps/web/src/components/AddWorktreeDialog.tsx`
- `apps/web/src/components/app-sidebar/WorktreeRow.tsx`
- `apps/web/src/components/settings-dialog/`
- `apps/web/src/lib/bootstrap.ts`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/stores/projects.ts`
- `apps/web/src/lib/stores/worktrees.ts`
- `apps/web/src/components/ui/command.tsx`
- `docs/agents/frontend.md`
- `docs/agents/architecture.md`

## Design Guidance

- Start from the user-facing outcome: Hubris actions should feel like they are
  part of one coherent command model instead of isolated component-local event
  handlers.
- Keep the system practical for Hubris’s current size and architecture.
- Prefer a small, understandable command model with strong reuse over a highly
  abstract framework.
- Bias toward making existing actions easier to discover, reuse, and migrate
  rather than inventing a large new taxonomy of command concepts.

## Deliverables

- Frontend command system with named commands and argument support
- Command palette integration over that command set
- Migration of most existing relevant UI actions onto commands
- Tests covering command registration, invocation, argument handling, and major
  UI integration flows

## Verification

- Verify commands can be discovered and executed from the command palette.
- Verify existing UI surfaces can trigger the same commands without duplicating
  action logic.
- Verify commands with optional arguments behave sensibly in both explicit and
  context-derived invocation paths.
- Run the relevant frontend tests you touch, then finish with:

```sh
mise run check
```
