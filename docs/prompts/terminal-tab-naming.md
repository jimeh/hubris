# Terminal Tab Naming

Hubris terminal tabs currently derive their labels from a few different sources:
numbered fallback titles, process names, and custom titles emitted by running
processes via escape sequences. I want to improve that model so tab naming feels
more useful and more intentional.

## Goal

Improve terminal tab naming so labels better reflect what the terminal is doing
while keeping the behavior understandable and configurable.

## Scope

- Focus on terminal tab title behavior and the settings that control it.
- Add the current shell directory as a first-class naming source, using `~` for
  the current user's home directory.
- Reshape the naming options so escape-sequence-driven custom titles are a
  separate on/off behavior, and smart naming is its own distinct mode.
- Leave implementation details and detection strategy to the executing agent.

## Desired Outcome

- Terminal tab naming has a clearer priority model.
- Hubris can show the terminal's current directory path when the active process
  is the shell itself.
- Hubris can show the current foreground process name when the terminal is not
  currently sitting at the shell.
- Disabling smart naming falls back to the current numbered terminal titles.
- Enabling custom escape-sequence naming allows process-provided titles to
  override the smart/default naming behavior.
- New installs and default settings enable both smart naming and custom
  escape-sequence naming.
- The resulting settings and behavior are easy for users to understand.

## Requirements

- Preserve numbered terminal naming as the baseline fallback behavior.
- Treat smart naming and escape-sequence naming as separate controls rather than
  one mixed mode.
- Smart naming should be enabled by default.
- Process-provided custom title handling via escape sequences should be enabled
  by default.
- In smart mode:
  - show the shell's current path when the shell process is the active process
  - show the foreground process name when a non-shell process is active
- Render home-relative shell paths with `~` instead of the full home directory.
- If escape-sequence naming is enabled and a process provides a custom title,
  that custom title should take precedence over smart naming.
- Keep manual/custom tab rename behavior coherent with the updated automatic
  naming system.

## Relevant Existing Code

- `apps/server/src/api/tabs.rs`
- `apps/server/src/api/terminal.rs`
- `apps/server/src/pty/live_tab.rs`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/stores/terminal.ts`
- `apps/web/src/components/tab-bar/SortableTabStrip.tsx`
- `apps/web/src/components/settings-dialog/TerminalSettings.tsx`
- `docs/agents/architecture.md`

## Design Guidance

- Optimize for labels that help users distinguish terminals at a glance without
  making the rules feel unpredictable.
- Keep the naming model simple enough that users can understand why a terminal
  currently has a given title.
- Avoid coupling the user-facing settings too tightly to internal detection
  mechanics; the prompt should describe behavior, not prescribe the exact
  implementation.
