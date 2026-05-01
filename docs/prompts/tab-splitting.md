# Tab Splitting

Add tab splitting to Hubris so a worktree can show multiple tab panes at once,
similar to VS Code.

## Goal

Let users split the main worktree area vertically and horizontally, move tabs
between panes, and create new panes by dragging tabs into split targets.

## Scope

- Focus on the main worktree tab/content area.
- Extend the existing tab experience rather than replacing it.
- Keep the feature practical and coherent with Hubris’s current tab model.

## Desired Outcome

- A worktree can contain multiple visible panes.
- Each pane can host tabs and show one active tab at a time.
- Users can split panes vertically and horizontally.
- Dragging a tab should support:
  - moving it into another existing pane
  - splitting a pane by dropping on its top/bottom/left/right half
  - dropping in the middle to move the tab into that pane without splitting
- Empty panes should close automatically.

## Relevant Existing Code

- `apps/web/src/components/WorktreeView.tsx`
- `apps/web/src/components/TabBar.tsx`
- `apps/web/src/components/tab-bar/SortableTabStrip.tsx`
- `apps/web/src/components/tab-bar/SortableTab.tsx`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/server/src/tab.rs`
- `docs/agents/architecture.md`

## Requirements

- Preserve existing tab behavior where it still makes sense:
  - activate
  - close
  - reorder
  - preview/pinned behavior
  - dirty-close confirmation
  - terminal/file/git diff tab support
- The design should work for current tab types and not paint future tab types
  into a corner.
- The feature should feel native to Hubris’s worktree-oriented model, not like a
  separate window manager bolted on top.
- Keep pane lifecycle intuitive:
  - splitting creates structure
  - moving tabs reorganizes structure
  - empty panes collapse away automatically
- Keep focus/selection behavior sensible after splits, moves, and closes.

## Design Guidance

- The current `WorktreeView` is effectively a single-pane tab host. This feature
  should evolve that into a pane layout model rather than layering hacks onto
  the existing single-active-tab rendering.
- Using the resizable shadcn component is a reasonable direction, but do not
  modify vendor primitives unnecessarily.
- Reuse current tab drag/drop behavior where practical, but expect pane-target
  drops to need additional structure beyond the current flat tab strip reorder
  logic.
- Keep the implementation comprehensible. Prefer a clear pane-tree or layout
  model over ad hoc nested state.

## Important Constraints

- Do not regress the current single-pane experience while adding multi-pane
  support.
- Be careful with component lifetime for heavy tab types like terminals and VS
  Code panes. Avoid unnecessary remount churn.
- Keep the right sidebar behavior coherent with the new pane layout.
- Do not let orphaned empty panes or invalid pane trees accumulate.

## Deliverables

- Split-pane support in the main worktree area
- Drag-and-drop tab movement and split targets
- Automatic cleanup of empty panes
- Tests covering pane layout behavior and major tab move/split flows

## Verification

- Verify tab splitting, tab movement, pane cleanup, and normal tab actions all
  work together.
- Run the relevant frontend tests you touch, then finish with:

```sh
mise run check
```
