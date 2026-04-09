# Frontend Gotchas

## shadcn / UI Primitives

- **Do NOT modify shadcn components**: Files under `apps/web/src/components/ui/`
  are managed vendor code. Editing them makes future shadcn updates painful. Put
  customizations in wrapper components or app-level code instead.
- **Sidebar resize ownership**: Keep sidebar resize customization in app-level
  files instead of `components/ui/sidebar.tsx` so shadcn sidebar upgrades remain
  copy-merge operations.
- **Sidebar menu primitives require provider context**: `SidebarMenuButton` and
  related `SidebarMenu*` primitives call `useSidebar()`. When reusing them
  outside a full `Sidebar`, wrap the render tree in `SidebarProvider` in app
  code/tests.
- **Popover lists inside React dialogs may need a dialog-local portal**:
  `apps/web/src/components/AddWorktreeDialog.tsx` mounts the start-point
  `Popover` into a container inside the dialog instead of the default body
  portal. Portalling that popover outside the dialog breaks wheel/trackpad
  scrolling on `CommandList` content.

## React Patterns

- **SSE init ordering**: All store handlers must be registered before
  `EventClient.connect()` — the snapshot fires immediately on connect. In React
  bootstrap, initialize project/worktree/tab stores before calling
  `events.connect()`.
- **StrictMode is enabled**: terminal remount/cleanup is generation-guarded.
  Keep websocket, reconnect timer, and post-open `requestAnimationFrame`
  handlers scoped to the active connection so stale callbacks from a previous
  mount cannot schedule extra sockets or duplicate terminal I/O.
- **Sidebar width updates are imperative during drag**: `apps/web/src/App.tsx`
  subscribes to sidebar width store changes and writes `--sidebar-width`
  directly to the rendered sidebar wrapper. Keep `isResizing` reactive, but
  avoid reintroducing a full React subscription to width or resize drags will
  rerender the app tree.

## Settings Store

- **Frontend settings saves are optimistic but backend-authoritative**: the
  browser applies local changes immediately, sends discrete
  `PATCH /api/settings` writes right away, and debounces typed terminal inputs
  (`systemFontFamily`, typed `fontSize`). Server responses and SSE are
  canonical: the store accepts newer generations, still applies equal-generation
  status changes, and on latest-request failures shows a toast then refetches
  `/api/settings` instead of retrying or rebasing unsaved local diffs.
- **Settings store adapters must use stable Zustand snapshots**: adapter hooks
  like `useThemeSettings`, `useTerminalSettings`, and `useWorktreeSettings` are
  selector hooks over the real `useSettingsStore`, not standalone Zustand
  stores. They cannot build fresh wrapper objects inside the selector passed to
  `useSettingsStore`. Select a shallow slice first, then run any caller selector
  against that slice, or React will hit `getSnapshot` and maximum update depth
  errors.

## Explorer

- **Explorer refresh UI should be stale-while-revalidate**: watcher-driven
  refreshes for already-loaded directories should keep cached children visible
  and use a refresh-specific status/indicator. Reusing the initial-load
  placeholder state makes subtree renames/removals flash.
- **Sidebar passive loads must not use `refreshVisiblePaths()`**:
  `refreshVisiblePaths()` is the invalidation path and force-refreshes git
  status. The right-sidebar visibility coordinator should use
  `loadDirectory("")`, `preloadVisibleDirectories()`, and `loadGitStatus()` for
  normal tab-open hydration, or it can spin on already-fresh state.

## Monaco Editor

- **Monaco theme/model ownership must stay global, not per-tab**: file/diff tabs
  should not each call `defineTheme`/`setTheme` from mount effects. Reordering
  tabs under React StrictMode can overlap Monaco cleanup with those global theme
  mutations and crash disposed editors. Apply theme idempotently from app-level
  code, and keep Monaco models alive across tab reorder churn with explicit
  cleanup only when tabs actually close.
- **Monaco file associations are not all under `basic-languages`**: Monaco
  `0.54.0` keeps JSON registration metadata in
  `esm/vs/language/json/monaco.contribution.js`, not `esm/vs/basic-languages/`.
  Any generator that mirrors Monaco file-extension coverage must scan both roots
  or `.json` files will fall back to `plaintext`.
- **Monaco contribution files can register multiple languages**:
  `cpp.contribution.js` registers both `c` and `cpp` from one file. The Monaco
  registry generator must parse every `registerLanguage(...)` or
  `languages.register(...)` block in a contribution file, not assume one
  language id per file.
- **Monaco `0.55.x` package-root import restores basic syntax highlighting**:
  `monaco-editor/esm/vs/basic-languages/_.contribution.js` no longer aggregates
  the basic-language registrations. For runtime editor bootstrap, import
  `monaco-editor` and keep only the Vite worker deep imports; otherwise many
  basic languages such as Rust and Markdown fall back to plaintext.

## Icon Theme

- **`material-icon-theme` manifest is not a complete browser file-type
  resolver**: `generateManifest()` follows the VS Code icon-theme manifest
  model, which may omit some generic language extensions (for example plain
  `.ts`) because VS Code can also use language IDs.
- **`material-icon-theme` browser resolution must include `languageIds` too**:
  plain path-based resolution for files like `.html` and `.yml` can miss custom
  icons if it only consults `fileNames` and `fileExtensions`. The generated
  manifest and browser resolver should carry `languageIds`, with a minimal alias
  layer such as `yml -> yaml`.
