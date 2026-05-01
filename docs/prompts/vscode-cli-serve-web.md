# VS Code CLI `serve-web` Support

Hubris currently manages the Coder `code-server` runtime for the `/code`
surface. Add support for the official VS Code CLI and its `code serve-web` mode
as an alternative backend for that same experience.

## Goal

Support the official VS Code CLI `serve-web` flow as a selectable alternative to
`coder/code-server`, while preserving the existing `/code` user experience as
much as practical.

## Scope

- This is an addition, not a replacement.
- Keep existing `coder/code-server` support working unless there is a strong
  reason to change shared abstractions.
- Focus on practical support for the Hubris-managed local runtime used behind
  `/code`.

## Existing Proxy Topology

Hubris effectively has two VS Code reverse proxy paths today:

- The Rust server proxy for browser-based `/code` access
- The Electron desktop proxy, which resolves the live VS Code upstream and
  proxies directly so desktop does not double-proxy through the Rust server

That distinction matters for this work. The implementation should keep a shared
core where behavior is genuinely common, but extract runtime-specific and
host-specific details cleanly:

- `coder/code-server` vs official `code serve-web` differences should not be
  hidden behind inaccurate assumptions
- Rust/browser proxy logic and Electron direct-proxy logic should each keep
  their own integration details where needed
- shared concepts like runtime selection, install metadata, status, and common
  connection info can still be centralized

## Important Notes

- Do **not** assume `code serve-web` uses the same flags, startup behavior, URL
  layout, auth model, or readiness checks as `coder/code-server`.
- The implementing agent should verify the real current CLI behavior before
  hardcoding assumptions:
  - verify the current official download URLs for the standalone VS Code CLI
  - verify the actual `code serve-web` flags supported by the current CLI
  - verify that the chosen download/install URLs still work
- If official docs and the actual CLI disagree, trust the actual current CLI and
  document the discrepancy.

## Official References To Check

- VS Code FAQ currently documents standalone download URL patterns like:
  - `https://update.code.visualstudio.com/{version}/cli-win32-x64/stable`
  - `https://update.code.visualstudio.com/{version}/cli-darwin-arm64/stable`
  - `https://update.code.visualstudio.com/{version}/cli-linux-x64/stable`
  - and `latest` can be used in place of `{version}`
- VS Code release notes for March 2024 mention `--server-base-path` support for
  `code serve-web`

These are only starting points. Re-check them before implementation.

## Relevant Existing Code

- `apps/server/src/code_server.rs`
- `apps/web/src/components/settings-dialog/VscodeSettings.tsx`
- `apps/web/src/lib/stores/codeServer.ts`
- `apps/desktop/src/protocol.ts`
- `docs/agents/backend.md`
- `docs/agents/desktop.md`

## Requirements

- Preserve the existing `/code` entry point from the browser’s perspective if
  possible.
- Support the official VS Code CLI as an alternative runtime choice, not just a
  one-off migration.
- Keep runtime-specific logic honest:
  - shared behavior can be abstracted
  - runtime-specific flags/download/install/readiness/auth behavior should stay
    explicit where needed
- Keep proxy-specific logic honest:
  - share common proxy/runtime concepts where practical
  - keep Rust server proxy details and Electron direct-proxy details separate
    where their behavior diverges
- Prefer using `code serve-web` features like server base path support instead
  of carrying forward path-rewriting that only exists for `coder/code-server`.
- Handle authentication/readiness correctly for the official runtime. The
  backend notes already call out `vscode-tkn` and authenticated `GET /code` as
  important details for `serve-web`.
- Update user-facing settings/status/install text so it no longer assumes only
  `coder/code-server` exists.

## Deliverables

- Hubris can install/manage the standalone official VS Code CLI runtime.
- Hubris can start and proxy `code serve-web`.
- The UI/settings surface can represent which runtime is being managed.
- Existing `coder/code-server` support still works, unless an intentional
  migration path is clearly implemented instead.

## Verification

- Verify the runtime can actually start and serve the workbench behind Hubris’s
  `/code` route.
- Verify auth cookies / websocket behavior / readiness probing for the official
  runtime.
- Run the relevant tests you touch, then finish with:

```sh
mise run check
```
