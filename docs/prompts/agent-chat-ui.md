# Agent Chat UI

Hubris should gain a first-class agent chat experience, starting with Codex via
the `codex` CLI's `app-server` command.

This is not just a message list UI. The implementation needs a practical model
for chat conversation state, backend-owned session/process lifecycle, idle
shutdown, and conversation resume so Hubris does not keep one Codex process
alive per inactive chat forever.

## Goal

Add a first-class agent chat feature that lets a user open a chat in Hubris,
talk to Codex in the context of the current project/worktree, stream replies in
the UI, and later resume that conversation even if the backing Codex
`app-server` process was shut down while idle.

## Scope

- Start with Codex only.
- Cover both frontend chat UI and backend chat/session lifecycle.
- Treat this as a real Hubris feature with persisted backend state, not as a
  frontend-only widget.
- Reuse existing Hubris architecture patterns where they still fit.
- Leave room for future agent providers, but do not build a large generic
  plugin/provider framework up front.

## Desired Outcome

- Users can create and reopen chat conversations inside Hubris.
- A chat is associated with the relevant Hubris context, likely at least a
  worktree and session level.
- The chat UI can show prior messages, composer state, streaming assistant
  output, and useful activity/error states.
- Hubris can spawn a Codex `app-server` process on demand for an active chat.
- Inactive chats do not require their own long-lived process.
- Hubris can shut down an idle Codex process after some timeout, keep the
  conversation state, and restart or reconnect on the next message.
- The resulting model feels coherent with Hubris's existing server-authoritative
  tabs/worktrees/state-sync architecture.

## Requirements

- Define a first-class backend chat/conversation model with stable IDs.
- Persist enough chat state that conversations survive Hubris restarts.
- Be explicit about the boundary between:
  - persisted conversation state
  - in-memory runtime process state
  - frontend-only ephemeral presentation state
- Support at least:
  - creating a new chat
  - listing/restoring existing chats
  - sending a user message
  - streaming assistant responses
  - surfacing errors/interrupted runs
  - resuming a previously inactive chat
- Model Codex process lifecycle separately from chat lifecycle:
  - a chat can exist without a running process
  - an active chat may cause a process to be started or reused
  - an idle process may be shut down without deleting the chat
- Decide how Hubris maps chats to Codex `app-server` processes:
  - one process per active chat
  - one process per worktree with multiple chats multiplexed
  - or another practical model The initial implementation should choose the
    simplest model that preserves correctness and future maintainability.
- Define an idle strategy:
  - when a chat process is considered idle
  - how shutdown is triggered/cancelled
  - what happens if a new message arrives during shutdown/startup
- Preserve a coherent resume story:
  - reopening a chat should restore transcript/history from backend state
  - sending the next message should transparently restart or reconnect the Codex
    backend as needed
- Be careful with naming. Hubris already has a `session` concept for tab
  grouping; do not create an ambiguous second meaning without tightening the
  terminology.

## Integration Requirements

- Reuse Hubris's standard communication model where practical:
  - REST for discrete actions/mutations
  - global SSE snapshot + incremental events for shared chat/process state
- Avoid polling-based frontend refresh loops.
- Keep backend-authoritative state on the backend. The chat transcript and
  lifecycle state should not live only in React state or browser storage.
- Fit into the existing worktree/tab model intentionally. If chat is presented
  as a tab type, make it a real first-class tab. If it is not a tab, explain why
  that is the better fit.
- Prefer dedicated Zustand stores for shared frontend chat state seeded from the
  SSE snapshot/event stream.
- If `@assistant-ui/react` is used, treat it as a view-layer accelerator, not as
  the source of truth for Hubris state or lifecycle decisions.

## Important Constraints

- Start narrow. Codex is the only required provider right now.
- Do not assume Hubris should keep a dormant Codex process alive for every chat.
- Do not overfit the design to whatever transport/API shape `app-server` happens
  to expose today if a thinner Hubris-owned abstraction is cleaner.
- Do not introduce a parallel ad hoc live-update system when SSE already covers
  shared state well.
- Do not push app-specific behavior into vendor-managed files under
  `apps/web/src/components/ui/`.
- Avoid unnecessary React `useEffect` orchestration if the same behavior can be
  driven from stores/state transitions more directly.

## Questions the Implementing Agent Should Resolve

- Should chat be a dedicated Hubris tab type, a right-sidebar tool, or another
  surface? Default to the option that best fits existing worktree workflows and
  server-authoritative state.
- What exact backend state needs to be persisted for a conversation to resume
  well?
- Does Codex `app-server` provide its own durable conversation/session handle,
  or does Hubris need to own more of the resume model itself?
- Is the current task system, process manager, or another abstraction the best
  place to model Codex lifecycle work?
- What idle timeout and shutdown semantics feel practical without making the UI
  feel unreliable or sluggish?
- What should happen if the Codex process dies unexpectedly mid-stream?

## Relevant Existing Code

- `apps/server/src/tab.rs`
- `apps/server/src/api/tabs.rs`
- `apps/server/src/api/events.rs`
- `apps/server/src/events.rs`
- `apps/server/src/task_manager.rs`
- `apps/server/src/api/tasks.rs`
- `apps/server/src/worktree_state.rs`
- `apps/server/src/pty/live_tab.rs`
- `apps/web/src/components/WorktreeView.tsx`
- `apps/web/src/lib/stores/tabs.ts`
- `apps/web/src/lib/stores/tasks.ts`
- `apps/web/src/lib/bootstrap.ts`
- `apps/web/src/components/ui/command.tsx`
- `docs/agents/architecture.md`
- `docs/agents/frontend.md`
- `docs/prompts/process-manager.md`
- `docs/prompts/task-system.md`
- `docs/prompts/worktree-state-persistence.md`
- `docs/prompts/frontend-command-system.md`

## Design Guidance

- Start from the user-facing workflow: open chat, ask something, see streaming
  progress, leave, come back later, continue seamlessly.
- Bias toward a small, understandable vertical slice over a broad agent
  platform.
- Keep the conversation model explicit and durable. Process lifetime is an
  implementation detail of serving a chat, not the definition of the chat.
- Prefer designs that make later expansion possible:
  - more agent providers
  - richer run states
  - slash commands / attachments / tool activity UI But do not implement all of
    that now unless it is directly needed.
- Call out tradeoffs clearly if the best first version is intentionally less
  ambitious, for example keeping the first chat surface tab-only, or limiting
  resume fidelity to what Codex `app-server` actually supports.

## Deliverables

- Backend chat/conversation model and persistence plan or implementation
- Backend lifecycle management for Codex `app-server` processes
- REST/SSE integration for chat creation, restore, message send, and live
  updates
- Frontend chat UI integrated into Hubris
- Tests covering the major state/lifecycle flows

## Verification

- Verify a user can create a chat, send messages, and receive streaming output.
- Verify the UI can restore prior conversation state from backend data.
- Verify idle chats do not keep unnecessary Codex processes alive.
- Verify a chat can resume after the backing process is shut down and later
  restarted.
- Verify error handling is sensible for startup failure, mid-stream failure, and
  reconnect/resume cases.
- Run the relevant tests you touch, then finish with:

```sh
mise run check
```
