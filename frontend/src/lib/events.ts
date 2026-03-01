export type EventHandler<T = unknown> = (data: T) => void;

const SSE_EVENT_NAMES = [
  'snapshot',
  'tab_created',
  'tab_closed',
  'tab_updated',
  'project_added',
  'project_removed',
  'project_updated',
  'projects_reordered',
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/**
 * SSE client for server state sync. Connects to
 * /api/events?session_id=..., dispatches typed events to
 * registered handlers. EventSource handles auto-
 * reconnection; server sends fresh snapshot on each
 * connect.
 */
export class EventClient {
  private es: EventSource | null = null;
  private handlers = new Map<string, Set<EventHandler>>();

  connect(sessionId = 'default'): void {
    if (this.es) return;

    this.es = new EventSource(
      `/api/events?session_id=${encodeURIComponent(sessionId)}`,
    );

    for (const name of SSE_EVENT_NAMES) {
      this.es.addEventListener(name, (e) => {
        const parsed = JSON.parse((e as MessageEvent).data);
        if (parsed.data === undefined) {
          console.warn(`SSE event "${name}" missing data field`, parsed);
          return;
        }
        this.dispatch(name, parsed.data);
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
  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  private dispatch(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
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
