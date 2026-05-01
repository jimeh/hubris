# Sidebar Hover Actions Truncation

The project/worktree list in the app sidebar currently reserves horizontal space
for hover-only action controls even when those controls are hidden. This causes
long project and worktree names to truncate earlier than they should.

Implement a frontend fix so truncation is based on what is actually visible.

## Goal

Make project and worktree row labels use the full available width when their
hover-only action buttons are hidden, and only give up width when those actions
become visible on hover or focus.

## Current Behavior

- In the app sidebar, project rows and non-local worktree rows hide action
  controls visually until hover.
- Even while hidden, those controls still consume layout space.
- As a result, long names truncate too early.
- The Changes view already has the desired behavior: stage/unstage/discard
  actions do not steal width until the row is hovered or focused.

## Relevant Files

- `apps/web/src/components/app-sidebar/ProjectRow.tsx`
- `apps/web/src/components/app-sidebar/ProjectHeaderRow.tsx`
- `apps/web/src/components/app-sidebar/WorktreeRow.tsx`
- `apps/web/src/components/app-sidebar/WorktreeRowContent.tsx`
- `apps/web/src/components/WorktreeGitStatusPanel.tsx`
- `apps/web/src/components/app-sidebar/WorktreeRowContent.test.tsx`
- `apps/web/src/components/app-sidebar/AppSidebarRoot.test.tsx`

## Likely Root Cause

- `WorktreeRowContent` bakes in `pr-8`, so every row reserves right-side space
  even when no actions are visible.
- `WorktreeRow` renders its action menu absolutely over the row, which works
  visually but depends on the row already reserving width.
- `ProjectRow` keeps its action area in normal layout with `ml-auto` and fades
  it with opacity, so the hidden project actions still occupy space.
- The Changes view solves this differently in
  `apps/web/src/components/WorktreeGitStatusPanel.tsx`, especially
  `ChangeRowFrame`, where the actions container starts at `max-w-0` with
  `overflow-hidden` and expands only on hover/focus.

## Requirements

- Fix both project rows and worktree rows.
- Do not reserve action width while the actions are hidden.
- Keep the current hover/focus affordance for actions.
- Preserve keyboard accessibility:
  - actions should still become available on focus within the row
  - row buttons and action menus must remain reachable and usable
- Preserve current drag-and-drop behavior for projects/worktrees.
- Preserve current selected-row styling and hover styling.
- Preserve the missing-on-disk warning icon behavior for worktrees.
- Do not modify shadcn vendor components under `apps/web/src/components/ui/`.

## Implementation Guidance

- Reuse the layout strategy from `ChangeRowFrame` in
  `WorktreeGitStatusPanel.tsx` rather than inventing a third pattern.
- Prefer making `WorktreeRowContent` capable of rendering:
  - a primary content area with `min-w-0 flex-1`
  - an optional action area that is collapsed by default and expands on
    hover/focus
  - any existing trailing content without breaking truncation
- Remove the unconditional right-padding reservation from `WorktreeRowContent`
  if that is no longer needed.
- For project rows, change the action slot so it does not consume width while
  hidden. Avoid opacity-only hiding when the node still participates in layout.
- Keep the local worktree row consistent with the shared row layout even though
  it does not currently have an action menu.
- Avoid introducing `useEffect` for this. This is a layout/CSS problem.

## Acceptance Criteria

- Long project names truncate later when the row is not hovered.
- Long worktree names truncate later when the row is not hovered.
- Hovering or focus-within on a row reveals its action controls smoothly.
- When actions become visible, the label can give up width and truncate as
  needed.
- No hidden action area should block pointer events.
- Project/worktree drag-and-drop still works.
- Existing warning/status affordances still render correctly.

## Testing

Add or update frontend tests to cover the layout contract at the class/DOM
level.

At minimum:

- `WorktreeRowContent.test.tsx`
  - assert the shared row no longer reserves permanent right padding for hidden
    actions
  - assert the hidden actions container is collapsed by default
  - assert the row includes hover/focus classes that expand the action area
- add a project-row-focused test
  - assert the project action container uses a collapsed-until-hover/focus
    pattern instead of layout-reserving opacity-only hiding
- keep or update existing tests covering hover styling and missing-on-disk
  warning accessibility

If a more integration-style assertion is easier, add it in
`AppSidebarRoot.test.tsx`, but avoid brittle computed-style assertions that
jsdom cannot verify reliably.

## Verification

Run the smallest relevant tests while iterating, then run the full required
check before finishing.

Suggested commands:

```sh
bun run --filter hubris-web vitest run \
  apps/web/src/components/app-sidebar/WorktreeRowContent.test.tsx \
  apps/web/src/components/app-sidebar/AppSidebarRoot.test.tsx \
  apps/web/src/components/app-sidebar/ProjectList.test.tsx

mise run check
```

## Notes

- Prefer a small, local refactor in the sidebar components over broader UI
  abstraction work.
- If there is a tradeoff between perfectly matching the Changes view internals
  and keeping sidebar code simple, keep the sidebar implementation simple while
  preserving the same user-visible behavior.
