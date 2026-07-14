# Testing Gotchas

## Vitest / jsdom

- **Radix Select tests need extra jsdom shims**: the React settings dialog uses
  Radix Select, which expects pointer capture and `scrollIntoView()`. In
  Vitest/jsdom, stub `hasPointerCapture`, `setPointerCapture`,
  `releasePointerCapture`, and `scrollIntoView` in `src/test/setup.ts`.
- **Vitest aliases `xterm.css` to an empty module**: tests should not parse
  `@xterm/xterm/css/xterm.css` under jsdom. Keep the Vite/Vitest alias in
  `apps/web/vite.config.ts` so terminal runtime styling stays a browser concern
  instead of noisy test overhead.
- **Injected test styles must still be valid CSS**: jsdom logs
  `Could not parse CSS stylesheet` when a test appends a `<style>` tag with
  placeholder text. If a test pre-seeds stylesheet state, use minimal valid CSS
  instead of raw markers like `existing`.

## Mock Patterns

- **Eager-import Vitest mocks may need `vi.hoisted(...)` state**: when a test
  switches from lazy `await import(...)` to top-level imports, any `vi.mock()`
  factory that closes over shared spies/classes can trip hoisting order errors
  (`Cannot access ... before initialization`). Move that shared mock state into
  `vi.hoisted(...)` instead of falling back to dynamic imports.
- **Settings store tests must clean up `matchMedia` listeners**:
  `apps/web/src/lib/stores/settings.ts` binds a singleton `prefers-color-scheme`
  listener on initialize. Tests that reset and reinitialize the store need
  `resetSettingsStoreForTests()` to remove that listener and clear its bound
  flag or later cases will reuse a stale callback.

## Test Organization

- **Sidebar SSE coverage is intentionally split across test layers**:
  `apps/web/src/components/app-sidebar/AppSidebarRoot.test.tsx` uses eager
  imports and synchronous rendering for snapshot/removal/sidebar UI checks,
  while `apps/web/src/lib/stores/worktrees.test.ts` owns
  `project_worktrees_updated` event coverage. Keep reducer-style SSE assertions
  in the store suite unless a true end-to-end sidebar regression needs a
  component-level check.
- **Hot Vitest suites should avoid per-test dynamic imports**: repeatedly
  calling `await import(...)` for App/store modules inside `beforeEach` or
  hot-path tests adds enough module/init overhead to slow the frontend suite.
  Prefer eager top-level imports in broad component/store suites unless a test
  truly needs module re-evaluation semantics.
- **The Monaco package-root runtime check lives in a smoke lane**:
  `apps/web/src/lib/monaco.runtime.smoke.test.ts` is intentionally excluded from
  the default `bun run test` unit suite and runs via `bun run test:smoke` plus a
  dedicated CI job. Keep fast unit coverage in `bun run test`; reserve
  package-root Monaco imports for smoke coverage.

## Rust Tests

- **Rust integration tests should disable Git commit signing**: local/global Git
  config may enforce GPG signing and break ephemeral test-repo commits. In test
  helpers that run `git commit`, pass `-c commit.gpgsign=false`.
- **Do not pause Tokio time in SQLx-backed socket tests**: SQLite startup waits
  on a standard worker thread that Tokio cannot observe, while socket readiness
  comes from the operating system. A paused current-thread runtime can
  auto-advance past either one. Keep these tests on real time; terminal
  heartbeat tests may use the debug-only
  `HUBRIS_TEST_TERMINAL_WS_PING_INTERVAL_MS` and
  `HUBRIS_TEST_TERMINAL_WS_STALE_AFTER_MS` overrides to stay fast. Debug dev
  servers also honor these variables, so leave them unset outside tests.
