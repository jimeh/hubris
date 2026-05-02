import type { EventKind } from "@/lib/contracts/sse.generated";
import { eventsUrl } from "./desktopRuntime";

export type SseEvent = EventKind;
export type SseEventName = SseEvent["type"];
export type SseEventData<K extends SseEventName> = Extract<
  SseEvent,
  { type: K }
>["data"];
export type EventHandler<T> = (data: T) => void;

const SSE_EVENT_NAMES = [
  "snapshot",
  "tab_created",
  "tab_closed",
  "tab_updated",
  "tabs_reordered",
  "worktree_tab_layout_updated",
  "project_added",
  "project_removed",
  "project_updated",
  "projects_reordered",
  "worktree_created",
  "worktree_deleted",
  "worktrees_reordered",
  "project_worktrees_updated",
  "worktree_files_updated",
  "worktree_git_status_updated",
  "settings_updated",
  "keybindings_updated",
  "vscode_updated",
  "managed_process_updated",
  "task_updated",
  "task_removed",
  "chat_conversation_created",
  "chat_conversation_updated",
  "chat_runtime_updated",
  "chat_app_server_updated",
  "chat_thread_stream_updated",
  "chat_message_delta",
  "chat_message_updated",
  "chat_run_updated",
  "chat_turn_updated",
  "chat_item_updated",
  "chat_activity_delta",
  "chat_activity_updated",
  "chat_pending_request_created",
  "chat_pending_request_updated",
  "chat_pending_request_resolved",
] as const satisfies ReadonlyArray<SseEventName>;

/**
 * SSE client for server state sync. Connects to
 * /api/events?session_id=..., dispatches typed events to
 * registered handlers. EventSource handles auto-
 * reconnection; server sends fresh snapshot on each
 * connect.
 */
export class EventClient {
  private es: EventSource | null = null;
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  connect(sessionId = "default"): void {
    if (this.es) return;

    this.es = new EventSource(eventsUrl(sessionId));

    for (const name of SSE_EVENT_NAMES) {
      this.es.addEventListener(name, (e) => {
        const parsed = JSON.parse(
          (e as MessageEvent).data,
        ) as Partial<SseEvent>;
        if (parsed.data === undefined) {
          console.warn(`SSE event "${name}" missing data field`, parsed);
          return;
        }
        this.dispatch(name, parsed.data as SseEventData<typeof name>);
      });
    }

    this.es.onerror = () => {
      // EventSource auto-reconnects. Server sends
      // fresh snapshot on reconnect.
    };
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
  }

  /**
   * Register a handler for an event type. Returns an
   * unsubscribe function.
   */
  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<SseEventData<K>>,
  ): () => void {
    const bucket = this.handlers.get(event) ?? new Set<EventHandler<unknown>>();
    bucket.add(handler as EventHandler<unknown>);
    this.handlers.set(event, bucket);
    return () => bucket.delete(handler as EventHandler<unknown>);
  }

  private dispatch<K extends SseEventName>(
    event: K,
    data: SseEventData<K>,
  ): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as EventHandler<SseEventData<K>>)(data);
    }
  }
}

// Module-level singleton
let client: EventClient | null = null;

export function getEventClient(): EventClient {
  if (!client) {
    client = new EventClient();
  }
  return client;
}
