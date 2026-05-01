# Codex App Server GUI Best Practices

This guide describes how to build a user-facing GUI on top of Codex `app-server`
JSON-RPC messages. It is written as an implementation reference for agents
building a Codex GUI from scratch.

The main goal is to turn a low-level stream of requests and notifications into a
stable, understandable conversation UI. Treat Codex messages as protocol events,
not as UI components. Normalize them into a small application model first, then
render that model.

## Core Model

Use three layers:

1. Protocol layer: line-delimited JSON-RPC over stdio.
2. Runtime event layer: canonical session, turn, item, content, request, and
   error events.
3. UI state layer: conversations, messages, activities, pending actions, plans,
   diffs, context usage, connection state, and session status.

Do not render directly from raw JSON-RPC messages. The GUI should be able to
reconnect, replay events, rebuild state from snapshots, and avoid duplicating
rows when streamed deltas arrive.

Recommended state shape:

- conversation/thread metadata,
- ordered turns,
- ordered items within each turn,
- active pending server requests,
- latest token usage,
- thread runtime status,
- connection/lifecycle notices,
- stream ownership and resume state.

## Message Categories

Codex app-server sends and receives four broad message shapes:

| Shape               | Meaning                                                    | GUI Responsibility                                                                      |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Client request      | GUI asks Codex to do something and waits for a result.     | Optimistically update local intent when appropriate, then reconcile with notifications. |
| Client notification | GUI tells Codex about a one-way lifecycle event.           | Usually no direct UI output.                                                            |
| Server request      | Codex asks the GUI for a decision or user input.           | Pause the turn, present a focused prompt, and respond exactly once.                     |
| Server notification | Codex reports session, turn, item, stream, or error state. | Normalize into user-visible messages, activities, statuses, and alerts.                 |

Use the app-server request id only for protocol response routing. For UI state,
create stable application ids for pending approvals, user-input prompts,
messages, and activity rows. Store enough provider ids for correlation, but do
not make UI state depend exclusively on transport ids.

## Event Admission And Compatibility

Add an explicit event admission layer before events reach UI state. Each
incoming app-server method should be classified as one of:

| Class             | Handling                                                                   |
| ----------------- | -------------------------------------------------------------------------- |
| State mutation    | Normalize into conversation, turn, item, request, or metadata state.       |
| Lifecycle notice  | Update auth, connection, config, login, setup, or warning state.           |
| Secondary channel | Route to a feature-specific controller such as realtime, search, or files. |
| Legacy event      | Translate to a modern internal event when useful; otherwise log/suppress.  |
| Unknown event     | Log with method and payload sample; avoid creating confusing UI rows.      |

Do not let every notification become a timeline row. Most thread metadata,
account, config, filesystem, and realtime messages should update state or
feature-specific controllers without cluttering the conversation.

Maintain a compatibility table for legacy event names. If app-server emits both
older `codex/event/*` methods and newer `thread/*`, `turn/*`, or `item/*`
methods, prefer the newer shape and make legacy events opt-in.

## Session Lifecycle

Recommended flow:

1. Spawn `codex app-server`.
2. Send `initialize`.
3. Send `initialized`.
4. Send `thread/start` for a new conversation or `thread/resume` for an existing
   provider thread id.
5. Mark the session ready only after the thread is open.

For existing threads, hydrate before rendering an editable live view:

- read thread metadata,
- list or page historical turns,
- resume the live stream when the thread may still be active,
- apply live events after the snapshot,
- deduplicate hydrated items against live events by provider ids.

User-facing states:

| State                      | UI Treatment                                                           |
| -------------------------- | ---------------------------------------------------------------------- |
| Starting                   | Disable send controls or show a subtle "Starting session" state.       |
| Ready                      | Normal composer and controls.                                          |
| Running                    | Show working indicator; allow interrupt.                               |
| Waiting for approval/input | Keep turn running; show the request near the composer or related item. |
| Error                      | Show an error banner and preserve conversation content.                |
| Closed/stopped             | Disable turn controls, allow restart/resume where possible.            |

Thread start/resume responses should update the stored provider thread id. If
resume fails because the provider thread no longer exists, a GUI may fall back
to `thread/start`, but it should make that recovery visible in logs or
diagnostics.

## Multiple Views And Stream Ownership

If the same thread can be open in multiple windows, tabs, or panes, designate a
single live stream owner. Other views should be followers that render the
owner's normalized state.

Recommended model:

- The owner receives app-server notifications and mutates thread state.
- Followers receive state snapshots or patches from the owner.
- Followers forward user actions to the owner instead of issuing competing
  live-turn mutations.
- Snapshots/patches should carry a monotonic version so stale follower updates
  can be ignored.
- Followers should ignore direct live mutation notifications for the followed
  thread, if those notifications are also being mirrored by the owner.

Forward these actions through the owner path:

- start turn,
- steer or edit an in-progress turn,
- interrupt turn,
- compact thread,
- approval decisions,
- permissions decisions,
- structured user-input responses,
- MCP elicitation responses,
- queued follow-up changes,
- model, reasoning, or collaboration mode changes.

This prevents duplicate rows, double approval responses, and out-of-order stream
state when multiple views are attached to the same thread.

## Turns

When the user sends a prompt:

1. Persist or render the user message immediately.
2. Send `turn/start` with text, attachments, model, approval policy, sandbox
   policy, and interaction mode.
3. Mark the turn as running.
4. Append assistant content from subsequent deltas.
5. Finalize the assistant response when the assistant item or turn completes.

Live events may arrive before hydration catches up or before the GUI has created
local placeholders. Treat that as recoverable:

- synthesize a missing turn if an item arrives first,
- synthesize a placeholder item for deltas when possible,
- replace placeholders with completed items when final payloads arrive,
- ignore duplicate or empty user-message items,
- keep a stable turn/item ordering independent of render timestamps.

If the user interrupts:

- Send `turn/interrupt`.
- Keep existing streamed text.
- Mark the turn interrupted only after command acknowledgement or matching
  notification.
- Avoid deleting partial assistant content unless the user explicitly chooses to
  discard it.

## Assistant Messages

`item/agentMessage/delta` is the primary assistant text stream.

Best practices:

- Append deltas to a stable assistant message id for the current turn/item.
- Render markdown incrementally if your renderer can handle partial markdown.
- If streaming is expensive, buffer deltas and flush:
  - at a regular short interval,
  - before showing an approval or user-input prompt,
  - when the assistant item completes,
  - when the turn completes.
- Always finalize the message on completion so copy buttons, timestamps, and
  completion styling can switch out of streaming mode.
- If an item completion contains final text and no deltas were rendered, use it
  as fallback assistant content.
- If the final item duplicates a streaming placeholder, replace the placeholder
  instead of appending a new row.

User presentation:

- Show assistant text as the primary conversation response.
- Show streaming state with subtle live timing or an active indicator.
- Show final elapsed time only after completion.
- Keep copy/export controls hidden or disabled until the message is complete.

## Tool And Work Activity

Tool-like item lifecycle events include command execution, file changes, MCP
tool calls, dynamic tool calls, web search, image view, and collaboration tool
calls.

Recommended presentation:

- Convert `item/started`, update/progress deltas, and `item/completed` into
  compact work-log rows.
- Collapse repeated lifecycle rows for the same tool call.
- Prefer a concise label plus optional detail over dumping raw payload JSON.
- Surface command strings, changed files, tool names, and short output previews
  when available.
- Keep raw payloads available in developer/debug mode, not in the default chat
  view.

Suggested display:

| Item Type               | Primary UI                                                     |
| ----------------------- | -------------------------------------------------------------- |
| Command execution       | "Ran command" row with command preview and exit/result detail. |
| File change             | "File change" row with changed path summary.                   |
| MCP tool call           | Tool row with server/tool name and progress if available.      |
| Dynamic tool call       | Tool row with tool name and argument/result summary.           |
| Web search              | Search row with query/status.                                  |
| Image view              | Image/context row when relevant.                               |
| Collaboration tool call | Nested-agent or delegated-work row.                            |
| Hook activity           | Compact lifecycle row when hooks start or complete.            |
| Auto-approval review    | Review/status row only when it affects user trust or outcome.  |
| Model reroute           | Small status row naming old model, new model, and reason.      |

Avoid showing every `item/started` row in the main timeline if it creates noise.
It is often better to show updates/completions, while keeping starts in an
expandable activity log.

Create synthetic timeline items for protocol states that users need to
understand but that are not assistant-authored messages:

- errors,
- guardian or policy warnings,
- model reroutes,
- permission requests,
- user-input requests,
- MCP elicitation requests,
- auto-approval review state,
- active todo/checklist plans.

## Command And File Output Deltas

Codex may stream:

- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `command/exec/outputDelta`

Do not automatically render these as assistant chat text. They are tool output,
not the assistant's answer.

Good options:

- Buffer output into the related tool activity.
- Show the first meaningful line as a compact preview.
- Provide an expandable terminal/output panel for long output.
- Truncate aggressively in the timeline and keep full output elsewhere.
- Treat file patch updates as file-change state, not as command output.
- If file-change output deltas are only diagnostic, sample or log them instead
  of rendering them in the main timeline.

When truncating output, make truncation explicit with a stable marker such as
`[output truncated]`, and keep enough metadata to let developer/debug views
explain what was omitted.

## Server-Initiated Requests

Server requests are different from notifications. They require exactly one
protocol response and should remain visible until resolved.

Recommended request lifecycle:

1. Validate that the request belongs to a known thread or recover gracefully.
2. Store a pending request record with protocol request id and UI id.
3. Attach it to the active conversation and, when possible, the related turn and
   item.
4. Mark the conversation unread or attention-needed.
5. Flush streamed text/output that would otherwise appear after the prompt.
6. Render a focused action surface near the composer or related timeline row.
7. Send one response.
8. Apply the response locally, then remove the request from pending state.
9. Also remove or mark it resolved if a `serverRequest/resolved` notification
   arrives.

Common request types:

| Request                | Recommended UI                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| Command approval       | Show command, cwd/context, reason, and scoped allow/deny actions.     |
| File-change approval   | Show affected paths, reason, and a diff or summary when available.    |
| Permissions approval   | Explain the permission scope and duration before allow/deny actions.  |
| Structured user input  | Render focused validated question controls near or over the composer. |
| MCP server elicitation | Render the elicitation form or decline automatically if unsupported.  |
| Dynamic tool call      | Route to a tool-specific controller and keep a pending activity row.  |

If a request type is unsupported, prefer a clear decline/error response over
leaving the app-server waiting indefinitely.

## Approvals

Server requests such as command or file-change approval must keep the specific
app-server request pending until the user responds. The GUI event loop and other
conversation controls should remain responsive.

Recommended flow:

1. Receive approval request.
2. Create a pending approval record with request id, type, turn id, item id,
   detail, and created time.
3. Flush any buffered assistant text before showing the approval UI.
4. Present a focused approval panel near the composer.
5. Prevent normal text from accidentally answering the approval. If follow-ups
   are supported, route them through the normal queue, steer, or interrupt
   behavior instead.
6. Provide clear actions such as Allow, Allow for Session, Deny, and Cancel when
   supported.
7. Return the response to Codex exactly once.
8. Mark the approval resolved and remove it from pending UI.

User presentation:

- Command approvals should show the command.
- File-change approvals should show the affected path or reason.
- Permission approvals should show the exact permission scope and whether it is
  temporary, session-scoped, or persistent.
- Multiple pending approvals should show count and process them in order.
- Stale approvals after reconnect should be cleared with an explanatory message,
  because in-memory protocol callbacks may no longer exist.

## Structured User Input

`item/tool/requestUserInput` asks the GUI to collect structured answers.

Recommended presentation:

- Render a focused question panel near or over the composer.
- Support one or more questions.
- Show progress such as `1/3` for multi-question prompts.
- Render options as buttons, not plain text.
- Support number-key shortcuts for the first several options.
- Allow free-form answers only when the schema or UI contract supports them.
- Disable submit until the active question is complete.

Response shape should preserve question ids and selected answer labels. After
responding, add a resolved activity so the pending panel disappears.

If questions include unsupported controls, fail closed: show a concise
unsupported-input message and return a decline/cancel response if the protocol
supports it.

## Plans

Codex can provide plans through either plan deltas or plan update notifications.

Handle two distinct concepts:

- Active task plan: current checklist or progress for an ongoing turn.
- Proposed plan: a durable plan document the user may review or implement.

Recommended presentation:

| Signal                             | UI Treatment                                                              |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `turn/plan/updated`                | Sidebar or compact checklist showing pending/in-progress/completed steps. |
| `item/plan/delta`                  | Buffer into a proposed-plan draft.                                        |
| completed plan item                | Render a durable proposed-plan card.                                      |
| turn completion with buffered plan | Finalize the proposed-plan card if no explicit completion arrived.        |

Keep proposed plans separate from normal assistant prose. They often need
actions such as Copy, export, open in a larger view, Implement, Refine, or Start
New Thread, depending on which actions the GUI supports.

While a plan is still streaming, label it as a draft or "writing plan" state.
After completion, switch to a durable "plan" state and enable copy/export/open
actions.

## Diffs And Changed Files

`turn/diff/updated` is a signal that the turn has file changes or a diff
available.

Recommended presentation:

- Attach changed-file summaries to the assistant response for that turn.
- Show file count plus additions/deletions when known.
- Offer a "View diff" action.
- Avoid blocking response completion while computing expensive diffs.
- Use placeholders if diff details are delayed, then replace with real data.

If your GUI supports rollback or checkpoints, bind them to turn-level diff
summaries rather than raw item ids.

## Context Usage

`thread/tokenUsage/updated` should not usually appear as a chat row.

Better UI:

- Show a compact context meter near the composer or model controls.
- Display used tokens, max context, percent used, and total processed tokens in
  a tooltip or popover.
- If automatic compaction is enabled, mention that in the tooltip.
- Update the meter from the latest token-usage event.

Only surface token usage in the timeline if it materially affects the user's
next action, such as compaction or an error.

## Reasoning Streams

Reasoning notifications may include:

- `item/reasoning/textDelta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`

Reasoning text is not the final answer. Present it carefully:

- Prefer concise "thinking" or progress summaries over raw reasoning text.
- Keep it collapsed by default.
- Do not mix reasoning into the assistant answer.
- If unavailable or intentionally hidden, show normal working state instead.

## Errors And Warnings

Use severity:

| Signal                     | UI Treatment                                                             |
| -------------------------- | ------------------------------------------------------------------------ |
| Retriable provider error   | Non-blocking warning activity. Keep turn running.                        |
| Fatal provider error       | Error activity plus session error banner.                                |
| Process stderr warning     | Developer-visible or compact warning row.                                |
| Process exit               | Session stopped/error state depending on exit code.                      |
| Config/deprecation warning | Settings or notification surface; avoid interrupting chat unless urgent. |

Error UI should preserve all conversation content. Do not clear streamed
assistant text just because the turn failed.

For protocol or transport failures:

- Fail pending client requests.
- Resolve or mark pending server requests as stale.
- Disable actions that cannot succeed.
- Offer restart/resume when possible.

## Thread And Metadata Events

Thread notifications should update application state, not clutter the timeline.

Suggested handling:

| Event Type                 | UI                                                                |
| -------------------------- | ----------------------------------------------------------------- |
| Thread started/resumed     | Internal session state; no chat row.                              |
| Thread name updated        | Update title/sidebar.                                             |
| Thread archived/unarchived | Move thread in list/filter.                                       |
| Thread runtime status      | Update composer/header controls.                                  |
| Thread token usage         | Update context meter.                                             |
| Thread closed              | Mark session closed.                                              |
| Thread compacted           | Update metadata; add an activity only when user action is needed. |

Other metadata and lifecycle events:

| Signal                         | UI Treatment                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| Account/auth changes           | Update account, login, or connection surface; avoid timeline rows.    |
| OAuth login completion         | Resolve the related login prompt.                                     |
| Config/deprecation notices     | Settings/status notification unless urgent.                           |
| Filesystem change              | Refresh watched file/review panes; avoid chat rows.                   |
| File search session updates    | Update the file picker/search controller.                             |
| App list or rate-limit updates | Update relevant controls or popovers; avoid timeline rows by default. |
| Skills changed                 | Refresh skill-aware UI only if the GUI exposes it.                    |

## Realtime And Secondary Channels

Some app-server notifications may describe realtime audio, transcription, app
lists, filesystem changes, account state, OAuth completion, or MCP status.

If your GUI does not implement those features:

- Decode and log them.
- Preserve raw payloads for debugging.
- Avoid showing confusing placeholder rows.
- Add explicit UI only when the user can act on the event.

Realtime and audio streams should usually remain outside the main text timeline.
If a realtime event needs to become durable chat history, convert it into a
normal user, assistant, or activity item with a stable id. Keep raw audio,
transcript deltas, SDP, and transport errors in the realtime feature controller
unless the user needs to act on them.

## Persistence And Replay

A robust GUI should be event-sourced or snapshot-backed.

Persist:

- user messages,
- assistant message deltas/completions,
- activity rows,
- proposed plans,
- pending server-request UI state, not in-memory protocol callbacks,
- session status,
- turn status,
- provider thread id/resume cursor,
- diff/checkpoint summaries,
- stream ownership and follower snapshot version, when multiple views can show
  one thread.

On reconnect:

- Load a snapshot before replaying live events.
- Deduplicate by event id and message id.
- Rebuild pending request display state from unresolved request activities.
- Mark request actions stale unless the current app-server process still owns
  the matching protocol callback.
- Re-subscribe to active/non-idle threads first.
- If using owner/follower views, hydrate the owner first and let followers
  attach to the owner's latest snapshot.

## Ordering And Correlation

Many useful UI states require correlation:

- assistant deltas to message id,
- tool output to item id,
- approvals to request id and item id,
- server-request resolved notifications to the internal pending request,
- diffs to turn id,
- plans to turn id or item id,
- child collaboration thread events to parent turn.

Best practices:

- Carry provider turn id, item id, and request id through normalized events.
- Generate deterministic UI ids from provider ids where possible.
- Use event sequence numbers or monotonic append order to sort activities.
- Do not rely on timestamps alone for lifecycle ordering.
- Treat unknown or missing ids as recoverable: create a fallback row and log.
- Correlate `serverRequest/resolved` back to pending request records, not just
  timeline items.
- Correlate output deltas only to tool/work items, never to assistant messages.

## Rendering Principles

Good Codex GUIs should feel calm under heavy event streams.

- Separate answer text from work log.
- Collapse noisy tool lifecycle events.
- Keep pending user action near the composer.
- Keep request prompts attached to conversation state so they survive rerenders.
- Keep warnings/errors visible but not destructive.
- Use progressive disclosure for raw output and payloads.
- Preserve partial work during failures.
- Avoid layout shifts while streaming.
- Keep controls stable during pending approvals/input.
- Prefer small status indicators over verbose status prose.

## Minimal UI Checklist

For a first implementation, build these surfaces:

- conversation timeline with user and assistant messages,
- working indicator and interrupt button,
- grouped work/activity log,
- pending approval panel,
- structured user-input panel,
- proposed-plan card,
- active plan/checklist sidebar or panel,
- changed-files/diff summary,
- context-window meter,
- session error banner,
- connection/auth/config status surface,
- reconnect/replay-safe state store.

## Specific Method Handling Reference

Use this as a checklist when wiring app-server methods into the GUI. The exact
payload shapes may evolve, but the UI-side responsibility should stay stable.

### Client Requests

| Method                      | UI-side handling                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/list`               | Populate recent conversations, archived filters, search results, and pagination. Do not treat results as live state until a thread is opened or resumed. |
| `thread/start`              | Create a conversation shell, then reconcile provider thread id and metadata from the response and follow-up notifications.                               |
| `thread/read`               | Hydrate thread metadata and available history before rendering an existing thread as editable.                                                           |
| `thread/turns/list`         | Page or backfill older turns. Deduplicate against already-rendered live turns/items.                                                                     |
| `thread/resume`             | Reattach to an existing live or resumable thread. Show resuming state until a snapshot or first live event is applied.                                   |
| `thread/fork`               | Start a derived conversation and make the relationship visible through title, context, or debug metadata.                                                |
| `turn/start`                | Commit the user message locally, start a running turn, and reconcile with `turn/started`.                                                                |
| `turn/interrupt`            | Request interruption while preserving partial output. Final state comes from acknowledgement or completion notification.                                 |
| `config/read`               | Seed settings, model/provider controls, feature flags, and warning surfaces.                                                                             |
| `account/login/start`       | Show login-in-progress state and recovery/cancel affordances.                                                                                            |
| `account/login/cancel`      | Clear active login UI and restore unauthenticated/previous account state.                                                                                |
| `windowsSandbox/setupStart` | Show setup progress if the GUI exposes sandbox setup.                                                                                                    |

### Thread And Turn Notifications

| Method                      | UI-side handling                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `thread/started`            | Upsert conversation metadata and mark the thread open. Avoid adding a chat row.                                               |
| `thread/name/updated`       | Update title/sidebar labels when the provided name is non-empty.                                                              |
| `thread/status/changed`     | Update runtime state used by composer, interrupt, and resume controls.                                                        |
| `thread/tokenUsage/updated` | Update the context meter and related tooltip/popover.                                                                         |
| `thread/archived`           | Remove or suppress the thread from normal recent lists and close related live surfaces where appropriate.                     |
| `thread/unarchived`         | Clear archive suppression and refresh recent/search lists.                                                                    |
| `thread/closed`             | Mark the conversation closed and disable actions that need a live thread.                                                     |
| `thread/compacted`          | Update context metadata; render a small activity only when the user needs to know or act.                                     |
| `turn/started`              | Ensure a turn exists, mark it running, store model/reasoning/collaboration metadata, and finalize stale prior active state.   |
| `turn/completed`            | Flush text/output queues, finalize status and error fields, update unread/follow-up state, and release turn-scoped resources. |
| `turn/diff/updated`         | Attach aggregate diff data to the turn and refresh changed-file/review surfaces.                                              |
| `turn/plan/updated`         | Update the active task checklist or todo-list item for the turn.                                                              |
| `hook/started`              | Add or update a compact hook activity and mark related work active.                                                           |
| `hook/completed`            | Complete the hook activity without creating duplicate timeline rows.                                                          |

### Item Notifications

| Method                              | UI-side handling                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `item/started`                      | Normalize and insert a streaming item. Synthesize a missing turn if needed, and ignore duplicate/empty user-message items. |
| `item/completed`                    | Flush item deltas, replace the streaming item with final content, and update timing/status.                                |
| `item/agentMessage/delta`           | Append batched text to the target assistant message.                                                                       |
| `item/plan/delta`                   | Append batched text to the proposed-plan draft.                                                                            |
| `item/reasoning/summaryTextDelta`   | Append batched text to the target reasoning summary part.                                                                  |
| `item/reasoning/summaryPartAdded`   | Ensure reasoning summary structure exists; no standalone chat row is needed.                                               |
| `item/reasoning/textDelta`          | Append batched text to the target detailed reasoning part if the GUI exposes it.                                           |
| `item/commandExecution/outputDelta` | Append batched output to the command/tool activity, with truncation.                                                       |
| `item/fileChange/outputDelta`       | Treat as diagnostic file-change output unless your GUI has a specific file-change output surface.                          |
| `item/fileChange/patchUpdated`      | Update or create the in-progress file-change/diff item.                                                                    |
| `item/mcpToolCall/progress`         | Update MCP tool progress only if the GUI has a useful progress surface; otherwise log/debug only.                          |
| `item/autoApprovalReview/started`   | Create or update an auto-approval review status item when it affects trust or outcome.                                     |
| `item/autoApprovalReview/completed` | Complete the auto-approval review status item.                                                                             |

### Server Requests

| Method                                       | UI-side handling                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`      | Store pending request, show command approval UI, and reply exactly once with the decision.                  |
| `item/fileChange/requestApproval`            | Store pending request, show file approval/diff UI, and reply exactly once with the decision.                |
| `item/permissions/requestApproval`           | Store pending request, show permission scope/duration, and reflect the response in request UI.              |
| `item/tool/requestUserInput`                 | Store pending request, render validated question controls, and return structured answers.                   |
| `mcpServer/elicitation/request`              | Render supported elicitation fields, or decline unsupported/invalid elicitations promptly.                  |
| `item/tool/call`                             | Route dynamic tool calls to a feature-specific controller and keep visible pending state while unresolved.  |
| `account/chatgptAuthTokens/refresh`          | Handle in the auth layer if supported; otherwise ignore without timeline output.                            |
| `applyPatchApproval` / `execCommandApproval` | Prefer modern approval request methods. If received, decline or log rather than leaving the server waiting. |

### Request Resolution And Errors

| Method                           | UI-side handling                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `serverRequest/resolved`         | Resolve/remove the matching pending request and update any synthetic request item.                                      |
| `error`                          | Add an error activity or banner, preserve partial conversation content, and include retry state/details when available. |
| `guardianWarning`                | Render a warning/status item only when it affects user trust or next action.                                            |
| `model/rerouted`                 | Add a small status item naming the previous model, new model, and reason.                                               |
| `model/verification`             | Update model/provider status if exposed; otherwise avoid timeline output.                                               |
| `sessionConfigured`              | Update session capability/config state; avoid chat rows.                                                                |
| `codex/event/session_configured` | Treat as compatibility input for session configuration state.                                                           |

### Lifecycle, Search, And Realtime Notifications

| Method                                 | UI-side handling                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `account/updated`                      | Refresh account/auth state and dependent controls.                                                     |
| `account/login/completed`              | Resolve login UI and refresh account state.                                                            |
| `account/rateLimits/updated`           | Update rate-limit notices, model controls, or popovers if exposed.                                     |
| `mcpServer/oauthLogin/completed`       | Resolve MCP OAuth prompts and refresh related tool/server state.                                       |
| `app/list/updated`                     | Refresh app/tool selection state if exposed.                                                           |
| `externalAgentConfig/import/completed` | Resolve import UI or show a small settings/status notice.                                              |
| `configWarning`                        | Show settings/status warning; do not interrupt chat unless urgent.                                     |
| `deprecationNotice`                    | Show settings/status notice.                                                                           |
| `windowsSandbox/setupCompleted`        | Resolve sandbox setup UI and show failure details if setup failed.                                     |
| `fs/changed`                           | Refresh watched review/file panes; avoid chat rows.                                                    |
| `fuzzyFileSearch/sessionUpdated`       | Update file-search session results.                                                                    |
| `fuzzyFileSearch/sessionCompleted`     | Finalize file-search results and clear active search state.                                            |
| `skills/changed`                       | Refresh skill-aware controls only if exposed.                                                          |
| `thread/realtime/itemAdded`            | Convert durable realtime delegation content into a normal user/message/activity item with a stable id. |
| `thread/realtime/started`              | Update realtime controller state, not the main text timeline.                                          |
| `thread/realtime/transcript/delta`     | Append inside the realtime transcript controller.                                                      |
| `thread/realtime/transcript/done`      | Finalize realtime transcript state.                                                                    |
| `thread/realtime/outputAudio/delta`    | Route to audio playback/buffer state, not timeline text.                                               |
| `thread/realtime/sdp`                  | Route to realtime transport setup.                                                                     |
| `thread/realtime/error`                | Show realtime-specific error state; add a timeline error only if the conversation is affected.         |
| `thread/realtime/closed`               | Mark realtime channel closed and release realtime resources.                                           |

## Recommended Normalized Events

A practical GUI can normalize Codex messages into this event vocabulary:

- `session.state.changed`
- `session.exited`
- `thread.metadata.updated`
- `thread.state.changed`
- `thread.token-usage.updated`
- `thread.runtime-status.changed`
- `thread.archived`
- `thread.unarchived`
- `turn.started`
- `turn.completed`
- `turn.diff.updated`
- `turn.plan.updated`
- `hook.started`
- `hook.completed`
- `assistant.delta`
- `assistant.completed`
- `plan.delta`
- `plan.completed`
- `reasoning.delta`
- `reasoning.summary.delta`
- `tool.started`
- `tool.updated`
- `tool.completed`
- `tool.output.delta`
- `file-change.patch.updated`
- `auto-approval-review.started`
- `auto-approval-review.completed`
- `approval.requested`
- `approval.resolved`
- `permissions.requested`
- `permissions.resolved`
- `user-input.requested`
- `user-input.resolved`
- `mcp-elicitation.requested`
- `mcp-elicitation.resolved`
- `server-request.resolved`
- `model.rerouted`
- `model.verification.updated`
- `lifecycle.notice`
- `account.updated`
- `auth.login.completed`
- `mcp-oauth.completed`
- `rate-limits.updated`
- `filesystem.changed`
- `file-search.updated`
- `file-search.completed`
- `realtime.state.changed`
- `realtime.transcript.delta`
- `realtime.transcript.completed`
- `realtime.audio.delta`
- `realtime.error`
- `guardian.warning`
- `runtime.warning`
- `runtime.error`

This keeps the UI independent from app-server protocol churn while preserving
the information needed to build a rich user experience.
