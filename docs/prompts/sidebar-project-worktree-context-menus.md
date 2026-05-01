# Sidebar Project/Worktree Context Menus

Replace the ellipsis dropdown menus used for sidebar project and worktree
actions with right-click context menus.

## Goal

In the app sidebar, project rows and worktree rows should expose their actions
through a context menu opened by right-clicking the row, instead of the current
three-dots menu button.

## Scope

- Frontend-only.
- Focus on the app sidebar project/worktree list.
- Do not change backend APIs or action semantics.

## Current Behavior

- Projects currently expose rename/remove through a three-dots dropdown menu.
- Worktrees currently expose rename/delete through a three-dots dropdown menu.
- Projects also have a separate "new worktree" button. That is not the thing
  being replaced.

## Desired Behavior

- Right-clicking a project row opens a context menu with the relevant project
  actions.
- Right-clicking a worktree row opens a context menu with the relevant worktree
  actions.
- Normal left-click behavior should stay the same:
  - project expand/collapse still works
  - worktree selection still works
  - drag-and-drop still works
- The menu content should preserve current actions and labels unless there is a
  good UX reason to change them slightly.

## Relevant Files

- `apps/web/src/components/app-sidebar/ProjectRow.tsx`
- `apps/web/src/components/app-sidebar/ProjectHeaderRow.tsx`
- `apps/web/src/components/app-sidebar/WorktreeRow.tsx`
- `apps/web/src/components/app-sidebar/ProjectActionMenu.tsx`
- `apps/web/src/components/app-sidebar/WorktreeActionMenu.tsx`

Useful references for existing context-menu patterns:

- `apps/web/src/components/tab-bar/SortableTab.tsx`
- `apps/web/src/components/WorktreeAllFilesPanel.tsx`
- `apps/web/src/components/WorktreeGitStatusPanel.tsx`

## Requirements

- Use the existing app context-menu primitives under
  `apps/web/src/components/ui/context-menu.tsx`.
- Do not modify shadcn vendor primitives directly.
- Preserve the current available actions for each row type.
- Preserve existing visual styling of the rows as much as practical.
- Do not regress keyboard accessibility. If removing the visible menu trigger
  would otherwise strand keyboard users, provide a reasonable keyboard path to
  open the same menu.
- Do not break mobile/sidebar responsiveness.
- Do not break drag-and-drop behavior for projects or worktrees.
- Do not open the action menu on ordinary left click.

## Notes

- The local worktree row may need different behavior than non-local worktrees,
  depending on which actions are currently supported.
- If the old dropdown menu components become dead code after the change, remove
  or refactor them.
- Keep this implementation pragmatic. It does not need a generalized
  command-system abstraction.

## Deliverables

- Sidebar project rows use a right-click context menu.
- Sidebar worktree rows use a right-click context menu.
- Obsolete ellipsis-trigger UI for those menus is removed.
- Tests updated to cover the new interaction pattern.

## Verification

Run targeted frontend tests while iterating, then finish with the normal repo
check.

Suggested commands:

```sh
bun run --filter hubris-web vitest run \
  apps/web/src/components/app-sidebar/*.test.tsx

mise run check
```
