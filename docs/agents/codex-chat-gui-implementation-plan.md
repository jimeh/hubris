# Codex Chat GUI Implementation Plan

This plan compares Hubris' current Codex chat implementation against
`docs/agents/codex-app-server-GUI-best-practices.md` and breaks the remaining
work into phases. Treat it as the working roadmap for evolving the current v1
chat tab into a durable, high-quality Codex GUI.

## Inputs

- `docs/agents/codex-app-server-GUI-best-practices.md`
- `docs/agents/codex-app-server-lifecycle-best-practices.md`
- `apps/server/src/chat.rs`
- `apps/server/src/api/chats.rs`
- `apps/server/src/events.rs`
- `apps/web/src/lib/stores/chats.ts`
- `apps/web/src/components/AgentChatTab.tsx`
- `apps/web/src/components/WorktreeChatsPanel.tsx`
- `apps/web/src/lib/bootstrap.ts`
- React performance guidance from `react-high-performance`
- React architecture guidance from `vercel-react-best-practices`

## Current Baseline

Hubris already has the right outer shape:

- Chat is a first-class tab type.
- Conversations and transcript messages are persisted in SQLite.
- `codex app-server --listen stdio://` is owned by backend runtime code, but the
  current implementation still effectively scopes one child process/runtime to
  one conversation.
- The frontend renders backend-authoritative chat detail, not browser-local
  history.
- REST handles discrete actions and lazy detail fetches.
- The global SSE stream carries summaries, runtime status, message deltas,
  message finalization, and run updates.
- The chat composer supports model, effort, and permission presets.
- Reasoning summary text is stored separately from assistant response text.

The main gap is not the tab or lifecycle shell. The gap is that Hubris still
collapses most app-server protocol into a small transcript projection:
`user message`, `assistant message`, `reasoning text`, `run status`, and
`runtime status`. Best-practice Codex GUIs need a richer normalized event model
for turns, items, tool activity, pending requests, approvals, plans, diffs,
context usage, warnings, replay, process ownership, and thread stream ownership.

## Core Design Direction

Keep the existing v1 architecture and make it deeper rather than broader:

- Hubris remains the source of truth for conversation rendering.
- `codex app-server` stays behind a Hubris-owned lifecycle and normalization
  boundary.
- Hubris should move to one app-server process per host session, with many Codex
  threads/chats multiplexed through that process.
- Conversation visibility should control thread stream ownership and
  `thread/unsubscribe` / `thread/resume`, not app-server process lifetime.
- Assistant text, reasoning, work activity, and requests become separate UI
  concepts.
- The chat store becomes normalized and optimized for streaming updates.
- Assistant UI primitives remain optional view helpers, never state owners.
- The global SSE stream remains the live shared-state transport.
- WebSockets remain unnecessary for the next iteration, but a deliberate
  per-chat transport is acceptable later if it clearly improves the assistant-ui
  integration or chat interaction model.

## Assistant UI Integration

The current `@assistant-ui/react` usage through `ExternalStoreRuntime` still
fits the near-term plan. Hubris owns the transcript, runtime, persistence, and
SSE state; assistant-ui receives the user/assistant transcript projection plus
`onNew` and `onCancel` callbacks.

Keep assistant-ui usage constrained this way while phases 0 through 7 are in
progress:

- Use assistant-ui for the composer runtime bridge and any useful message
  primitives.
- Feed assistant-ui from normalized Hubris state, not raw app-server events.
- Do not enable assistant-ui editing, branching, regeneration, or thread-list
  features until Hubris can persist and replay those semantics.
- Render Codex-specific activity, approvals, plans, diffs, context usage, and
  reconciliation as Hubris timeline rows around the assistant-ui transcript
  projection.

Assistant-ui's newer `AssistantTransport` feature is worth revisiting after the
normalized timeline model exists. It is designed for backends that stream full
agent state snapshots and support bidirectional commands, which is close to the
direction Hubris is taking for Codex chat. If adopting it gives us better
assistant-ui integration than `ExternalStoreRuntime`, a dedicated per-chat tab
transport is acceptable. Hubris already treats terminal tabs as special
WebSocket-backed live surfaces, so a chat-specific WebSocket or transport is not
architecturally off-limits.

The important constraint is intentionality: do not accidentally add a parallel
chat live-update path while SSE is still the source of shared state. If we move
to `AssistantTransport`, define the ownership boundary first:

- Decide whether AssistantTransport becomes the authoritative live transcript
  stream for open chat tabs, while global SSE keeps summaries and unloaded-chat
  dirty markers.
- Decide how AssistantTransport snapshots are derived from the same persisted
  Hubris timeline state used by REST/SSE.
- Decide how secondary browser windows converge when one window has an active
  per-chat transport and another only has the global SSE stream.
- Decide whether REST remains responsible for discrete actions such as create,
  reopen, settings, and history fetches.
- Keep Codex app-server JSON-RPC hidden behind the Hubris backend normalizer in
  either model.

## App-Server Lifecycle Direction

The lifecycle guide changes the runtime target from "one app-server process per
conversation" to "one app-server process per host session, many thread streams."
This should become part of the early implementation work, because it affects
runtime state, pending request ownership, resume semantics, and how events are
routed to conversations.

Target behavior:

- Start and initialize one app-server process for the Hubris host session,
  either at backend activation or on first Codex UI/API use.
- Keep the app-server process alive until host shutdown, explicit restart,
  incompatible config change, fatal protocol state, or parent process exit.
- Do not stop the process just because a chat tab is idle or hidden.
- Track each conversation's provider thread id, resume state, stream owner, and
  thread runtime status separately from the process lifecycle.
- Use `thread/unsubscribe` to release inactive thread streams.
- Use `thread/resume` to reattach a conversation when a user opens it, sends a
  turn, answers a pending request, or recovers from process restart.
- Deduplicate concurrent `thread/resume` calls per conversation.
- Keep only a bounded number of inactive owner streams loaded; use the lifecycle
  guide defaults as starting points: 60 minutes inactive unsubscribe, four
  inactive streams retained, and 15 seconds retry delay after unsubscribe
  failure.
- Preserve actionable waiting states such as approvals and structured input
  after unsubscribe.
- On app-server crash, mark live conversations `needs_resume`, stale any
  transport-owned pending requests, preserve transcript/activity state, and
  avoid tight auto-restart loops.

This does not conflict with possible future per-chat UI transports. A per-chat
WebSocket or AssistantTransport connection can still attach to Hubris state, but
it should not imply one Codex process per chat.

## Gap Analysis

| Area               | Current behavior                                                             | Best-practice target                                                                                                    | Impact                                                                      |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Runtime ownership  | One child app-server is effectively scoped to one active conversation.       | One initialized app-server process per host session, multiplexing multiple provider threads.                            | Avoids unnecessary processes and matches app-server lifecycle guidance.     |
| Idle management    | Idle policy focuses on shutting down per-chat runtimes.                      | Release inactive thread streams with `thread/unsubscribe`; keep process alive.                                          | Reduces cold starts and keeps app/server state coherent.                    |
| Resume state       | Resume is mostly tied to restarting a per-chat runtime.                      | Track `needs_resume`, `resuming`, and `resumed` per conversation/thread stream.                                         | Makes hidden tabs, second windows, and process restarts predictable.        |
| Initialization     | Each spawned process is initialized as part of per-conversation runtime use. | Initialize once per host process and expose process-level `starting`, `initializing`, `ready`, `fatal`, `stopped`.      | Separates host failure from individual chat failure.                        |
| Protocol admission | `handle_provider_notification` switches directly on a small set of methods.  | Classify every app-server message as response, request, notification, lifecycle, item, stream, warning, or unsupported. | Avoids dropped events and confusing UI states when app-server adds methods. |
| Server requests    | Approval and user-input requests are auto-declined as unsupported.           | Persist pending requests, show focused UI, respond exactly once, and reconcile resolution.                              | Required for full-access workflows, command approvals, and MCP elicitation. |
| Tool activity      | Command, file, tool, and output events are mostly ignored.                   | Render tool/work activity as expandable rows, not assistant prose.                                                      | Users need to see what Codex is doing without polluting the final answer.   |
| Turns and items    | `chat_runs` and `chat_messages` approximate one active turn.                 | Persist provider turn ids and item ids with stable normalized item records.                                             | Enables replay, ordering, request correlation, and richer rendering.        |
| Reasoning          | Summary deltas append to `reasoning_text` on assistant messages.             | Store reasoning as structured per-turn or per-item activity, with collapse state in UI.                                 | Avoids losing or misplacing thinking/progress output.                       |
| Assistant text     | Agent message deltas append to one assistant message.                        | Continue this projection, but link it to provider item id and final item payload.                                       | Preserves transcript while allowing item-level reconciliation.              |
| Plans              | Plan events are not modeled.                                                 | Persist plan state and show current plan as a progress widget or timeline item.                                         | Makes long-running turns understandable.                                    |
| Diffs              | Diff events are not modeled.                                                 | Persist summarized diff metadata and link to worktree diff views.                                                       | Helps users review code changes from the chat timeline.                     |
| Context usage      | Token/context events are not modeled.                                        | Store latest context usage per conversation/runtime and expose a calm meter.                                            | Helps users understand context pressure without noisy rows.                 |
| Errors             | Errors set run/message/runtime failure state, preserving some text.          | Distinguish protocol errors, runtime exits, turn failures, warnings, and request failures.                              | Improves recovery and avoids hiding partial useful output.                  |
| Replay             | Non-terminal persisted runs are reconciled narrowly.                         | Add explicit replay/reconciliation state and item-level idempotency.                                                    | Makes reloads and second browser sessions trustworthy.                      |
| SSE shape          | Transcript updates are message-centric.                                      | Add normalized turn, item, activity, request, plan, diff, and context events.                                           | Keeps all clients convergent without polling.                               |
| Frontend store     | Detail stores nested message arrays; each delta rewrites a detail object.    | Normalize by conversation, message, item, activity, request, and run ids.                                               | Reduces render blast radius during streaming.                               |
| Rendering          | Directly renders every message in a scroll area.                             | Timeline rows subscribe narrowly and support calm streaming, auto-follow, and eventual virtualization.                  | Prevents slowdowns in long chats.                                           |
| Composer           | Send/cancel, model, effort, permission exist.                                | Add pending request actions, stale request handling, and capability-aware disabled states.                              | Makes interaction safe while Codex waits for input.                         |

## Target Backend Model

Keep the existing tables as the transcript projection and add richer normalized
state beside them. This avoids a risky one-step migration while preserving the
current UI source of truth.

### Existing Tables To Keep

- `chat_conversations`: conversation identity, tab linkage, latest run/error,
  selected model/effort/permissions, provider thread id, resume state, stream
  ownership hints, and last known thread runtime status.
- `chat_messages`: durable transcript projection for user and assistant text.
- `chat_runs`: high-level turn/run state used by summaries and runtime badges.

### New Tables To Add

- `chat_app_server_instances`: optional persisted diagnostics for host-scoped
  app-server restarts, versions, fatal errors, and last startup metadata. The
  live process handle remains in memory.
- `chat_thread_streams`: per-conversation stream state keyed by provider thread
  id, including resume state, owner token, last subscribe/resume/unsubscribe
  attempt, inactive deadline, and last runtime status.
- `chat_turns`: one provider turn per user send, with provider turn id, status,
  timestamps, user message id, assistant message id, and reconciliation state.
- `chat_items`: normalized app-server items keyed by provider item id when
  available. Store item type, status, title/summary, linked message id, linked
  turn id, sequence, and compact JSON metadata.
- `chat_item_outputs`: appendable output streams for command output, file
  output, tool output, reasoning summaries, and debug/detail payloads.
- `chat_pending_requests`: server-initiated requests requiring one response.
  Store request id, method, turn id, item id, status, params JSON, response
  JSON, created/resolved timestamps, and stale reason.
- `chat_plans`: latest structured plan per active turn plus historical plan
  updates if needed for replay.
- `chat_diff_summaries`: latest diff metadata per turn, including changed file
  counts and optional links into Hubris diff tabs.
- `chat_context_usage`: latest context/token usage per conversation/thread.
- `chat_protocol_events_debug`: optional bounded debug ring for raw payloads in
  development builds or explicit diagnostic mode.

### Persistence Rules

- Persist user messages immediately on send.
- Create `chat_turns`, `chat_runs`, and assistant placeholders before starting
  the provider turn.
- Apply app-server notifications idempotently by provider turn id, item id, and
  normalized sequence.
- Persist assistant transcript deltas with a short backend debounce, but keep
  item/activity deltas separate from assistant prose.
- Persist pending requests before responding to or surfacing them.
- Mark pending requests stale when the app-server process exits, stream
  ownership is lost, a new process starts without reconciliation, or the turn
  becomes terminal.
- Never require a live Codex process to display transcript, activity history,
  request history, plans, diffs, or context usage.
- Never kill app-server merely to make an inactive conversation idle. Idle chat
  state is represented by thread unsubscribe/resume state.

## Target SSE and REST Contracts

Snapshots should stay summary-oriented. Full transcript and activity detail
should remain lazy per open conversation tab.

### Snapshot Additions

- Host app-server lifecycle summary.
- Conversation summaries, unchanged.
- Thread stream/runtime summaries by conversation.
- Active turn summaries for conversations with live or non-terminal runs.
- Pending request summaries for visible conversations.
- Context usage summaries for sidebar/runtime badges.

### New Incremental Events

- `chat_turn_updated`
- `chat_app_server_updated`
- `chat_thread_stream_updated`
- `chat_item_started`
- `chat_item_updated`
- `chat_item_completed`
- `chat_activity_delta`
- `chat_activity_updated`
- `chat_pending_request_created`
- `chat_pending_request_updated`
- `chat_pending_request_resolved`
- `chat_plan_updated`
- `chat_diff_updated`
- `chat_context_usage_updated`
- `chat_reconciliation_started`
- `chat_reconciliation_completed`
- `chat_reconciliation_failed`

### REST Additions

- `GET /api/chats/{conversation_id}/timeline`
- `GET /api/chats/{conversation_id}/requests`
- `POST /api/chats/{conversation_id}/requests/{request_id}/resolve`
- `GET /api/chats/{conversation_id}/activity/{item_id}`
- `GET /api/chats/{conversation_id}/diff-summary`
- `POST /api/chats/{conversation_id}/resume`
- `POST /api/chats/{conversation_id}/unsubscribe`
- `POST /api/codex-app-server/restart`

The existing `GET /api/chats/{conversation_id}` can include enough timeline data
for v2, but adding narrower endpoints keeps initial tab load small once activity
and diff details grow.

Resume and unsubscribe can stay backend-internal at first. Expose REST endpoints
only when the UI needs explicit retry/reconnect controls or diagnostics.

## Target Frontend Store Shape

Streaming chat is hot-path state. The store should avoid cloning whole detail
objects and remapping all messages for every token.

Recommended normalized shape:

```ts
type ChatStore = {
  appServerStatus: CodexAppServerStatus;
  conversationsById: Record<string, ChatConversationSummary>;
  runtimesByConversationId: Record<string, ChatRuntimeStatus>;
  threadStreamsByConversationId: Record<string, ChatThreadStreamStatus>;
  loadedConversationIds: Record<string, true>;
  dirtyConversationIds: Record<string, true>;

  messageIdsByConversationId: Record<string, string[]>;
  messagesById: Record<string, ChatMessage>;

  runIdsByConversationId: Record<string, string[]>;
  runsById: Record<string, ChatRun>;

  turnIdsByConversationId: Record<string, string[]>;
  turnsById: Record<string, ChatTurn>;

  itemIdsByTurnId: Record<string, string[]>;
  itemsById: Record<string, ChatItem>;

  activityIdsByItemId: Record<string, string[]>;
  activitiesById: Record<string, ChatActivity>;

  requestIdsByConversationId: Record<string, string[]>;
  pendingRequestsById: Record<string, ChatPendingRequest>;
};
```

Selector rules:

- Select ids first, then row components subscribe by id.
- Return stable empty arrays/objects from selectors.
- Do not filter and sort inside `useSyncExternalStore` selectors.
- Batch incoming SSE deltas per animation frame or short interval.
- Use equality gates before replacing objects.
- Mark unloaded conversations dirty instead of loading detail from SSE.
- Keep composer local draft in component or a tiny per-tab store, not in the
  global hot stream.
- Use `startTransition` for non-urgent sidebar/list recomputation after SSE
  bursts.
- Use `useDeferredValue` only when future search/filter UI can lag behind user
  typing.

## Target UI Model

The chat tab should render a timeline, not just a message list:

- User message row
- Assistant response row
- Collapsible reasoning/progress block
- Tool or command activity row
- File change activity row
- Plan/progress widget
- Diff summary widget
- Approval or input request card
- Warning/error card
- Context usage badge or meter

Rendering rules:

- Only `item/agentMessage/*` becomes assistant prose.
- Reasoning stays collapsed by default and visually separate.
- Tool output is expandable and never merged into assistant bubbles.
- Command output should preserve monospace formatting and truncation controls.
- Pending approvals appear near the composer and in timeline context.
- Completed approvals remain visible as compact audit rows.
- Runtime and turn status should be calm; avoid flickering lifecycle text.
- Preserve partial assistant text and activity when a run fails.
- Auto-scroll only when the user is already near the bottom.
- Do not steal scroll position when old messages or activity hydrate.
- Long chats should move toward row virtualization or `content-visibility`.

## React Performance Constraints

Apply the project React guidance deliberately:

- Treat streaming deltas as hot state and isolate them to the smallest
  subscribing row.
- Treat model lists, settings, and static capabilities as cold state.
- Avoid derived-state effects for transcript transformations; derive during
  render from normalized ids and records.
- Avoid request waterfalls: load conversation detail and model capabilities in
  parallel when opening a chat tab.
- Lazy-load heavy optional surfaces such as diff inspectors, raw protocol
  viewers, and markdown/highlight bundles if they become large.
- Do not create inline component types inside render.
- Keep memoization targeted. Add `memo`, `useMemo`, or `useCallback` only when
  referential stability prevents real rerenders or expensive recalculation.
- Prefer CSS containment, `content-visibility`, and stable row geometry before
  introducing a complex virtualization dependency.
- Use passive scroll listeners and refs for scroll position tracking.
- If draft persistence is added, version browser storage and keep it separate
  from backend-authoritative transcript state.

## Phased Work Plan

### Phase 0: Protocol And Lifecycle Inventory

Goal: make app-server protocol and lifecycle behavior observable and testable
before expanding the UI.

Backend work:

- Add a narrow Codex protocol normalizer module with explicit method
  classification.
- Add a host-scoped app-server lifecycle model that separates process state from
  thread stream state, even before the current runtime is fully migrated.
- Add a compatibility table for current and legacy app-server method names.
- Add fixture-driven parser tests using captured JSON-RPC lines.
- Add fixture coverage for `initialize`, `thread/start`, `thread/resume`,
  `thread/unsubscribe`, server requests, notifications, closed transport, and
  malformed lines.
- Add a fake app-server stream harness for runtime tests, including multiple
  concurrent provider thread ids through one transport.
- Add debug logging that names normalized event kinds without dumping large
  payloads by default.

Frontend work:

- Add no major UI changes.
- Add type placeholders only if generated contracts require them.

Verification:

- Unit tests prove server requests with both `id` and `method` are classified as
  requests, not responses.
- Unit tests prove unsupported methods become explicit ignored/debug events.
- Unit tests prove lifecycle state distinguishes process readiness from per
  conversation resume state.
- Existing chat send/stream tests continue passing.

### Phase 1: Shared App-Server Runtime And Thread Streams

Goal: replace per-conversation app-server child processes with one initialized
host-scoped app-server and per-conversation thread stream state.

Backend work:

- Introduce an app-server manager owned by the chat service or app state.
- Spawn `codex app-server --listen stdio://` once per host session or on first
  Codex use.
- Send `initialize` before user-visible requests and expose `starting`,
  `initializing`, `ready`, `fatal`, and `stopped` states.
- Route JSON-RPC responses by request id through the shared connection.
- Route server notifications and requests by provider thread id, turn id, item
  id, or pending request metadata to the owning conversation.
- Track per-conversation stream state: `needs_resume`, `resuming`, `resumed`,
  owner token, last runtime status, inactive deadline, and unsubscribe retry.
- Start new conversations with `thread/start` through the shared manager.
- Resume existing conversations with deduplicated `thread/resume`.
- Release inactive non-visible streams with `thread/unsubscribe` instead of
  killing the app-server process.
- Mark live streams `needs_resume` after app-server crash or restart.
- Preserve current transcript rendering and send/interrupt behavior while the
  runtime ownership changes.

Frontend work:

- Add app-server lifecycle and per-thread stream status to chat store contracts.
- Show process-level fatal/initializing state separately from per-chat running
  state where needed.
- Keep the current chat tab UI otherwise stable.

Verification:

- Rust tests for lazy/eager app-server startup and single initialization.
- Rust tests for multiple conversations sharing one fake app-server transport.
- Rust tests for concurrent resume deduplication.
- Rust tests for inactive `thread/unsubscribe` and retry-on-failure behavior.
- Rust tests for process crash marking live conversations `needs_resume`.
- Existing chat send, stream, interrupt, model list, and settings tests still
  pass.

### Phase 2: Normalize Turns, Items, And Assistant Text

Goal: preserve current user-visible behavior while introducing stable provider
turn and item records.

Backend work:

- Add `chat_turns` and `chat_items` migrations.
- Link `chat_runs` and `chat_messages` to normalized turns/items.
- Normalize `item/started`, `item/agentMessage/delta`,
  `item/reasoning/summaryTextDelta`, `item/completed`, and `turn/completed`.
- Make item finalization idempotent.
- Keep `chat_messages` as the transcript projection.
- Regenerate SQLx and TypeScript contracts.

Frontend work:

- Keep the current message UI.
- Hydrate new turn/item detail silently for future rows.
- Add store tests proving message rendering remains stable through deltas.

Verification:

- Rust persistence tests for turns/items.
- Runtime tests for duplicate/out-of-order item completion where practical.
- Vitest tests for unchanged transcript rendering.

### Phase 3: Store Normalization And SSE Batching

Goal: reduce render blast radius before adding more high-volume streams.

Backend work:

- Keep existing message SSE events.
- Optionally add `revision` or monotonic sequence fields to detail payloads and
  deltas.

Frontend work:

- Refactor chat detail state into normalized maps.
- Batch SSE chat deltas per animation frame or short debounce.
- Replace broad transcript selectors with id-list and row-by-id selectors.
- Keep stable empty references for unloaded conversations.
- Memoize only row components that receive stable primitive/id props.

Verification:

- Vitest tests for snapshot hydration, unloaded dirty markers, delta batching,
  and second-client convergence.
- Browser check with a long streaming response and React Profiler sampling.
- Confirm no `getSnapshot should be cached` warnings.

### Phase 4: Work Activity Rows

Goal: show what Codex is doing without mixing tool output into the response.

Backend work:

- Add `chat_item_outputs` or `chat_activities`.
- Normalize command execution, command output deltas, file changes, tool calls,
  and tool output into activity records.
- Truncate or chunk large outputs while keeping detail fetchable.
- Persist final status, duration, exit code, and concise summary when present.

Frontend work:

- Add timeline row types for activity start, streaming output, completion, and
  failure.
- Render command output in collapsed monospace detail by default.
- Show concise running status near the assistant response.
- Add row-level loading/error states for lazily fetched large activity details.

Verification:

- Runtime tests using fake command output streams.
- Component tests for collapsed/expanded activity rows.
- Browser test that command output does not appear inside assistant prose.

### Phase 5: Pending Requests, Approvals, And User Input

Goal: stop auto-declining app-server requests and make Codex interaction safe.

Backend work:

- Add `chat_pending_requests`.
- Persist app-server requests before surfacing them.
- Support resolving approval requests through REST.
- Support resolving structured user input requests through REST.
- Enforce exactly-once response semantics.
- Mark requests stale when app-server ownership changes, stream ownership is
  lost, or the turn becomes terminal.
- Reconcile `serverRequest/resolved` notifications when app-server emits them.

Frontend work:

- Add request cards near the composer and contextual timeline rows.
- Show command/file approval details with permission context.
- Disable unsafe duplicate actions while a request is resolving.
- Keep composer usable where safe, but make turn-blocking state clear.
- Add stale request UI that explains why the action can no longer be answered.

Verification:

- Rust tests for approve, deny, stale, duplicate resolution, and runtime exit.
- Component tests for approval cards and stale states.
- Browser test approving a command that needs elevated permissions.

### Phase 6: Plans, Diffs, And Context Usage

Goal: expose higher-level Codex progress signals.

Backend work:

- Add `chat_plans`, `chat_diff_summaries`, and `chat_context_usage`.
- Normalize `turn/plan/updated`, `item/plan/delta`, `turn/diff/updated`, and
  `thread/tokenUsage/updated`.
- Link diff summaries to worktree file/diff surfaces where possible.

Frontend work:

- Add a compact plan widget with completed/current/pending steps.
- Add a diff summary card with "open diff" affordances.
- Add a context meter in the header or composer control strip.
- Keep all three surfaces compact and non-chatty.

Verification:

- Rust normalizer tests for plan/diff/context payload variants.
- Component tests for plan update replacement and context meter updates.
- Browser test that plan updates do not cause scroll jumps.

### Phase 7: Replay, Resume, And Multi-View Convergence

Goal: make reloads, secondary browsers, and process restarts feel coherent.

Backend work:

- Add explicit reconciliation states to turns and runtime summaries.
- On startup/reopen, reconcile non-terminal turns with
  `thread/read(includeTurns=true)` where possible.
- Rebuild transcript projection from normalized items when needed.
- Mark irreconcilable active work interrupted without deleting partial content.
- Ensure pending requests from dead app-server processes or lost stream owners
  become stale.

Frontend work:

- Show reconciliation status only when it affects user trust.
- Keep already-loaded transcript visible during reconciliation.
- Apply replayed item/message updates idempotently.

Verification:

- Runtime tests for process death mid-stream, restart reconciliation, and failed
  reconciliation.
- Two-client browser test for convergence while a turn is streaming.

### Phase 8: Timeline Polish And Long-Chat Performance

Goal: make the UI feel like a purpose-built Codex GUI.

Backend work:

- Add compact summary fields where frontend currently derives expensive labels
  from large payloads.
- Add pagination or windowed detail fetches if transcript size requires it.

Frontend work:

- Refine visual hierarchy using Hubris theme tokens.
- Add markdown rendering only where needed and lazy-load heavy syntax support.
- Add row containment and `content-visibility` for long transcripts.
- Evaluate virtualization after row containment and normalized subscriptions.
- Add keyboard handling for approvals, composer focus, and cancel.
- Add accessibility labels for status, request cards, and model controls.

Verification:

- Component tests for row variants.
- Manual browser trace on a long conversation with streaming output.
- Confirm bundle impact from any markdown/highlight dependencies.

## Recommended First Slice

Start with phases 0 through 3 before adding visible feature complexity:

1. Introduce a protocol normalizer and fixture tests.
2. Move from per-conversation app-server processes to one host-scoped app-server
   with per-thread stream state.
3. Add turn/item persistence while keeping current transcript rendering.
4. Normalize the frontend chat store and batch streaming deltas.

This sequence reduces architectural risk. It also prevents the UI work in later
phases from being built on per-chat process ownership or a message-only store
that will need another rewrite as soon as tool activity and approvals arrive.

## Non-Goals For The Next Iteration

- Do not replace the Hubris transcript source of truth with assistant-ui state.
- Do not add a second live-update transport for chat unless it is a deliberate
  AssistantTransport/per-chat transport migration with a documented ownership
  boundary.
- Do not keep or add one Codex app-server process per conversation.
- Do not use process shutdown as normal chat idle management.
- Do not build a generic multi-provider framework before Codex is solid.
- Do not render raw JSON-RPC payloads in normal chat rows.
- Do not persist every raw app-server event indefinitely.
- Do not introduce virtualization before measuring normalized rows and CSS
  containment.

## Test Matrix

Backend:

- Protocol classification for responses, requests, notifications, and unknowns.
- Host-scoped app-server startup, initialize, fatal, stopped, and restart
  states.
- Multiple conversations multiplexed through one app-server process.
- Thread stream resume, unsubscribe, inactive limits, retry, and `needs_resume`
  state.
- Persistence for turns, items, activities, requests, plans, diffs, and context.
- Shared transport serialization during startup, shutdown, send, interrupt,
  resume, unsubscribe, and request resolution.
- Process death mid-stream with partial output preserved.
- Reconciliation of non-terminal turns after restart.
- SSE snapshots and incremental events for all normalized state.

Frontend:

- Store hydration and delta batching.
- Selector stability and no infinite `useSyncExternalStore` loops.
- Lazy transcript and timeline detail loading.
- Timeline row rendering for messages, reasoning, activities, requests, errors,
  plans, diffs, and context usage.
- Two-client convergence for streaming and request resolution.
- Scroll preservation while activity rows expand or hydrate.
- Composer disabled/enabled behavior during running, cancelling, approval, and
  stale-request states.

End-to-end:

- Create chat, send message, stream answer, show reasoning separately.
- Run a command-producing turn and verify activity rows.
- Trigger an approval, approve/deny once, and continue the turn.
- Reload during a running turn and reconcile correctly.
- Open a second browser and observe the same live timeline state.
- Open two chats, send turns through one shared app-server process, and verify
  events route to the correct conversation.
- Let an inactive thread unsubscribe while app-server remains alive, then send a
  follow-up and resume transparently.

Finish feature phases with the relevant touched suites and then:

```sh
mise run check
```
