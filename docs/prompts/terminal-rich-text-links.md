# Terminal Rich Text Links

Hubris terminals already detect and open visible URLs in the Xterm frontend. I
want to explore support for rich text hyperlinks inside terminal output, where
arbitrary text can behave like a link to an HTTP page.

## Goal

Investigate how to support terminal-emitted rich hyperlinks in Hubris's
Xterm-based terminals, and implement support if it is practical and robust.

## Scope

- Focus on the frontend terminal/Xterm integration first.
- Preserve existing plain-URL link behavior.
- Avoid unnecessary backend changes unless the terminal transport truly needs
  them.

## Current State

- `apps/web/src/lib/terminal/xterm.ts` already wires up
  `@xterm/addon-web-links`.
- Hubris currently supports modifier-click opening for visible URLs and shows a
  hover tooltip for those links.
- This likely means plain URL detection already works, but arbitrary-label
  hyperlinks do not.

## Desired Outcome

- If the terminal output includes a supported rich hyperlink format, Hubris
  should surface it as an interactive link inside the terminal.
- Link interaction should feel consistent with existing terminal link behavior:
  hover affordance, modifier-click follow, safe `window.open` behavior, etc.
- If full support is not realistic with the current stack, document the actual
  constraints clearly and implement the narrowest useful improvement you can.

## Relevant Files

- `apps/web/src/lib/terminal/xterm.ts`
- `apps/web/src/components/TerminalTab.tsx`
- `apps/web/src/components/terminal/useTerminalConnection.ts`
- `apps/web/src/lib/terminal/xtermAdapter.test.ts`
- `apps/web/src/components/TerminalTab.test.tsx`

## Requirements

- Reuse the existing terminal link behavior where practical instead of creating
  a completely separate interaction model.
- Preserve current visible-URL handling.
- Do not regress terminal input, selection, resize, reconnect, or performance.
- Keep security conservative:
  - do not silently auto-open links
  - keep explicit user interaction required
  - prefer a narrow, well-understood set of supported URI schemes unless there
    is a strong reason to broaden it
- Keep the implementation compatible with React StrictMode and the current
  terminal lifecycle.

## Investigation Notes

- Determine whether the desired behavior maps cleanly to a standard terminal
  hyperlink escape sequence format such as OSC 8, or whether Claude Code is
  doing something else.
- Check what the current Xterm version and addons can support directly before
  inventing custom parsing.
- If custom handling is required, keep it small and localized to the terminal
  adapter layer.

## Deliverables

- Rich hyperlink support in Hubris terminals, or a clearly documented partial
  implementation if full support is not practical.
- Preserved existing URL-link behavior.
- Tests covering the new link behavior at the terminal adapter level.

## Verification

Run focused terminal frontend tests while iterating, then the normal repo checks
before finishing.

Suggested commands:

```sh
bun run --filter hubris-web vitest run \
  apps/web/src/lib/terminal/xtermAdapter.test.ts \
  apps/web/src/components/TerminalTab.test.tsx

mise run check
```
