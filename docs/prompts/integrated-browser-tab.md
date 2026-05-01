# Integrated Browser Tab

Add a lightweight integrated browser to Hubris as another tab type.

The goal is to let users open and preview local web servers running in the
current project/worktree, or quickly browse docs and other pages, without
leaving Hubris.

## Goal

Introduce a browser-style tab that feels native to Hubris’s existing tab model,
without turning the app into a full general-purpose browser.

## Scope

- Add a new tab type for browser/web content.
- Fit it into the existing server-authoritative tab system.
- Keep the feature focused and lightweight.

## Desired Outcome

- Users can open a browser tab inside a worktree.
- The tab can load local dev servers and ordinary web pages where allowed.
- The browser tab integrates with the existing tab bar, worktree tab model, and
  active-tab behavior.
- The experience should be good enough for local preview and quick reference
  use, not a replacement for a full external browser.

## Relevant Existing Code

- `apps/server/src/tab.rs`
- `apps/server/src/api/tabs.rs`
- `apps/web/src/components/WorktreeView.tsx`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/tabPresentation.ts`
- `docs/agents/architecture.md`
- `docs/agents/desktop.md`

## Requirements

- Add this as a real first-class Hubris tab type, not as an ad hoc frontend
  overlay.
- Keep the implementation compatible with the existing tab lifecycle: create,
  activate, reorder, close, snapshot/SSE updates, etc.
- Keep the UI intentionally lightweight:
  - address/location input
  - loading/navigation affordances as needed
  - enough controls for preview workflows
- Prefer behavior that is especially good for local project/worktree servers.
- Preserve the current worktree-oriented mental model. Browser tabs should make
  sense within a worktree context.

## Important Constraints

- Be careful about desktop vs web differences. Electron has stricter rules and
  existing origin/security constraints; do not assume the same embedding
  approach works identically in both browser and desktop.
- Do not casually punch holes in desktop security policy just to make arbitrary
  web pages work.
- Expect some sites/pages to refuse embedding or behave differently inside an
  embedded surface.
- If there are unavoidable limitations, make them explicit and choose a
  pragmatic fallback rather than forcing a brittle solution.

## Design Guidance

- Keep the feature small and composable.
- Avoid turning this into a large browser-state architecture on day one.
- Favor a narrow initial feature set that is clearly useful: local preview,
  basic navigation, reload, URL entry, and sensible tab labels.
- If special handling is needed for local loopback/dev-server URLs, do it
  intentionally rather than as a side effect of general URL loading.

## Deliverables

- A new integrated browser tab type
- UI and tab presentation support for that tab type
- Basic navigation/loading experience suitable for local preview use
- Tests covering the new tab type and the main tab lifecycle it participates in

## Verification

- Verify the new tab can be created, activated, persisted through normal tab
  state updates, and closed correctly.
- Verify local dev-server preview works in the intended environments.
- Run the relevant tests you touch, then finish with:

```sh
mise run check
```
