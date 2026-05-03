# Codex App Server Lifecycle Best Practices

This guide describes how a GUI should manage the `codex app-server` process and
the JSON-RPC conversations running through it.

The important distinction is that the app-server process lifecycle and the
thread stream lifecycle are separate. Keep the process scoped to the app or host
session. Manage inactive conversations with thread-level unsubscribe and resume
operations, not by killing the process after the user is idle.

## Terms

| Term                  | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| App-server process    | The local or remote `codex app-server` runtime.                     |
| JSON-RPC connection   | The stdio, socket, or host bridge connected to app-server.          |
| Thread                | A persistent Codex conversation identified by a provider thread id. |
| Stream owner          | The view/client currently receiving and mutating live thread state. |
| Follower              | Another view of the same thread that mirrors owner state.           |
| Resume state          | GUI state such as `needs_resume`, `resuming`, or `resumed`.         |
| Thread runtime status | Server-reported idle, active, approval, or input status.            |

## Observed Baseline

The official GUI behavior points to these defaults:

- Start the app-server process eagerly during host activation.
- Send `initialize` immediately after spawn and wait for its response.
- Keep app-server alive for the host session.
- Do not idle-kill the app-server process merely because the user has stopped
  typing or no thread is visible.
- Tear app-server down when the host is disposed, reloaded, closed, or when a
  restart/update flow explicitly replaces it.
- Manage idle conversations with `thread/unsubscribe`.
- Mark unsubscribed conversations as `needs_resume`.
- Later reattach with `thread/resume` when the user opens or acts on the
  conversation.

Recommended default timings derived from the same behavior:

| Purpose                                    | Default          |
| ------------------------------------------ | ---------------- |
| Inactive owner thread unsubscribe          | 60 minutes       |
| Maximum inactive owner streams kept loaded | 4                |
| Failed unsubscribe retry delay             | 15 seconds       |
| Prewarmed or ephemeral thread freshness    | about 10 minutes |

These values are practical defaults, not protocol requirements.

## When To Start App-Server

Start app-server once per host session, not once per thread.

Good start points:

- app activation,
- first opening of the Codex UI,
- first request that needs Codex state,
- reconnecting after a host-level runtime restart,
- switching to a different configured runtime or host.

Starting eagerly during app activation is usually best for desktop or editor
integrations because recent threads, login state, model lists, config warnings,
and connection badges can be ready before the user sends a prompt.

The process launch should:

- resolve the configured Codex executable or bundled fallback,
- pass the `app-server` subcommand,
- preserve the host environment,
- apply proxy environment variables,
- prepend any bundled binary directory to `PATH`,
- set a conservative log level,
- set product/origin metadata when available,
- support platform-specific launch wrappers such as WSL or remote hosts.

Expose clear lifecycle states to the GUI:

| State          | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `starting`     | Process is being spawned.                             |
| `initializing` | JSON-RPC transport exists, waiting for `initialize`.  |
| `ready`        | Initialization completed and requests may flow.       |
| `fatal`        | Process exited unexpectedly or initialization failed. |
| `stopped`      | Process was intentionally torn down.                  |

## Initialization

After spawn, send `initialize` before any user-visible request. Include client
name, title, version, and capability flags.

While waiting for the initialize response:

- buffer server notifications that can be safely replayed,
- reject or defer user requests until ready,
- treat unexpected server requests as protocol errors or warnings,
- record the startup phase for diagnostics.

When initialization succeeds:

- store server version, user agent, and negotiated capabilities,
- mark the connection ready,
- flush buffered notifications in order,
- allow thread list, read, start, and resume requests.

When initialization fails:

- mark the app-server state fatal,
- preserve the error message,
- notify all views,
- stop or isolate the broken process before allowing restart.

## When Not To Stop App-Server

Do not stop app-server just because:

- the user has not sent a prompt recently,
- the Codex panel is hidden,
- a single thread is idle,
- all visible views are followers,
- the recent conversation list is loaded,
- no tool is currently streaming output.

Stopping the process for ordinary idle time creates avoidable cold starts,
breaks background server state, complicates pending requests, and forces every
conversation to resume after a trivial UI pause.

Prefer leaving app-server alive and unsubscribing inactive thread streams.

## When To Stop App-Server

Stop app-server on host lifecycle boundaries or explicit runtime replacement:

- app, extension, or window disposal,
- full reload,
- user-initiated restart,
- app-server update that requires a restart,
- switching executable, runtime host, or incompatible config,
- fatal protocol state where the transport can no longer be trusted,
- parent process shutdown.

Before stopping, mark the process as stopping so new requests do not enter the
old transport.

Do not stop while work is active unless the user explicitly requested a restart
or quit. Active work includes:

- in-progress turns,
- command or file approvals,
- permission requests,
- structured user-input prompts,
- MCP elicitation prompts,
- realtime sessions,
- active subagent or delegated work,
- pending JSON-RPC requests that mutate state.

If the user requests a restart while work is active, show the cost clearly:
ongoing turns may stop, pending approvals may become stale, and open threads
will need resume.

## How To Stop App-Server

A clean stop sequence should:

1. Stop accepting new requests.
2. Mark pending request promises as cancelled or failed.
3. Remove process stdout, stderr, exit, and error listeners.
4. Close the JSON-RPC transport.
5. Ask for graceful shutdown if the protocol/runtime supports it.
6. Terminate the child process if it is still running.
7. Force-kill after a short grace period if termination hangs.
8. Clear startup buffers and partial line parsers.
9. Reset initialized/ready state.
10. Clear prewarm, ephemeral, and pending-start tracking.
11. Notify all views of the stopped or fatal state.

If the runtime only supports process termination, use a normal termination
signal first. Reserve force-kill for hung exits.

Do not silently drop pending protocol work. Resolve it as cancelled, failed, or
stale so UI controls can leave loading states.

## Idle Thread Management

Idle management should happen at the thread stream level.

Track whether each conversation has an active view. When a conversation is:

- stream-owned by this client,
- already `resumed`,
- not visible or active,
- not doing work that must remain live,

start inactivity tracking.

After the inactive threshold, send:

```json
{
  "method": "thread/unsubscribe",
  "params": {
    "threadId": "<thread-id>"
  }
}
```

Also unsubscribe older inactive owner streams when the number of inactive
streams exceeds the configured maximum. A useful default is to keep at most four
inactive owner streams loaded.

Do not unsubscribe a thread that should stay loaded:

- active thread runtime status,
- in-progress turn,
- pending approval,
- pending permission request,
- pending structured user input,
- pending MCP elicitation,
- pending realtime handoff,
- currently visible view.

After successful unsubscribe:

- keep the transcript and metadata in local UI state,
- set `resumeState` to `needs_resume`,
- clear local stream ownership,
- update runtime status to idle unless waiting on user action,
- close related background terminal sessions if no view is active,
- keep the conversation in recent lists.

If unsubscribe fails, keep the stream state unchanged and retry later. A
15-second retry delay is a reasonable default.

## Runtime Status After Unsubscribe

The UI should preserve actionable waiting states after unsubscribe.

If a pending request still needs a user decision, keep the conversation visibly
active:

| Pending state          | Runtime status                       |
| ---------------------- | ------------------------------------ |
| Command/file approval  | active, waiting on approval          |
| Permission request     | active, waiting on approval          |
| MCP elicitation        | active, waiting on approval or input |
| Structured user input  | active, waiting on user input        |
| No pending user action | idle                                 |

This lets the sidebar or thread list continue to show that the user must act,
even though the live stream has been released.

## When To Resume

Resume a thread when the user or system needs a live stream and the local state
is not already attached.

Resume when:

- opening a conversation whose `resumeState` is `needs_resume`,
- sending a new turn to an existing conversation without a stream owner,
- interacting with a pending approval or input after reconnect,
- returning to a thread after app-server restart,
- recovering from an unavailable owner view,
- opening subagent, file approval, or side-conversation details,
- reconnecting after a transport loss.

Do not resume if:

- the conversation is already `resumed` and this view owns the stream,
- a resume for the same conversation is already in progress,
- a follower can forward the action to a live owner,
- the thread was archived or removed.

Deduplicate concurrent resumes per conversation. Multiple UI components may ask
to resume the same thread at once; all of them should await the same promise.

## How To Resume

A robust resume flow:

1. Ensure a conversation shell exists locally.
2. Set `resumeState` to `resuming`.
3. Read thread metadata without full turns when possible.
4. Hydrate the recent tail of turns.
5. Merge hydrated turns with any existing local turns by stable ids.
6. Build resume params from stored thread settings and current UI settings.
7. Send `thread/resume`.
8. Merge turns returned by the resume response.
9. Update metadata, cwd, rollout path, source, git info, model, reasoning
   effort, collaboration mode, and runtime status.
10. Mark the conversation `resumed`.
11. Mark the conversation streaming.
12. Set the current view as stream owner.
13. Broadcast a state snapshot to follower views.
14. Load older turns in the background if pagination indicates more history.

The resume request should carry enough state to continue the thread correctly:

- `threadId`,
- rollout path,
- cwd,
- model provider,
- service tier,
- approval policy or reviewer when relevant,
- sandbox policy when relevant,
- config values,
- base and developer instructions,
- personality,
- persisted extended history preference,
- whether already hydrated turns should be excluded from the response.

If resume fails:

- set `resumeState` back to `needs_resume`,
- keep the transcript visible,
- show a recoverable error,
- leave controls disabled until retry or new start is possible.

## Restart And Crash Recovery

On process exit, distinguish clean and unexpected exits.

For unexpected exits, collect diagnostic context:

- exit code,
- signal,
- process id,
- whether initialization had completed,
- last outbound method,
- executable name,
- most recent warning or error line from stderr.

Then:

- mark app-server fatal,
- notify all views,
- reject pending requests,
- clear process state,
- mark live conversations as `needs_resume`,
- avoid silently auto-restarting in a tight loop.

Automatic restart can be reasonable if it uses backoff and never hides repeated
failures. User-initiated restart is safer for editor-style GUIs because it makes
the cost of stopping active work explicit.

After a successful restart, do not replay old transport messages. Rehydrate
recent conversations and resume only the threads the user opens or that need
live handling.

## Prewarm And Ephemeral Threads

Prewarming can reduce latency for likely new conversations:

- send `thread/start` before the user submits,
- track the pending start separately from normal user starts,
- associate the prewarmed thread with cwd or workspace context,
- consume it only if it is still fresh,
- suppress duplicate `thread/started` UI noise when the real conversation adopts
  the prewarmed thread.

Use a short freshness window. About 10 minutes is a reasonable upper bound.

Ephemeral threads should not pollute the normal recent conversation list:

- recognize ephemeral thread sources,
- keep them routed to the initiating feature,
- suppress unrelated future notifications after the feature is done,
- expire suppression after a short window.

## Multiple Views

For multiple views of one thread, keep only one stream owner.

The owner:

- receives app-server notifications,
- mutates normalized thread state,
- answers server requests,
- sends turn and interrupt requests,
- broadcasts snapshots or patches.

Followers:

- render the owner's state,
- ignore duplicate live mutation notifications for the followed thread,
- forward user actions to the owner,
- become eligible to resume only if the owner disappears.

If a follower action cannot reach the owner, mark the conversation
`needs_resume` and resume locally before retrying.

## Minimal Implementation Checklist

- One app-server process per host session.
- Initialize before user requests.
- Buffer safe notifications during initialization.
- Route all JSON-RPC responses by request id.
- Reject or cancel pending requests on shutdown.
- Keep process lifetime independent from conversation visibility.
- Use `thread/unsubscribe` for inactive owner streams.
- Preserve transcripts when unsubscribing.
- Mark unsubscribed streams `needs_resume`.
- Deduplicate `thread/resume` per conversation.
- Hydrate metadata and recent turns before or during resume.
- Merge hydrated, resumed, and live turns by stable ids.
- Mark all live streams `needs_resume` after process reconnect.
- Surface fatal process errors to every view.
- Make explicit restarts warn about active work.
