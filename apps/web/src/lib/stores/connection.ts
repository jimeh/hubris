import { create } from "zustand";
import { getEventClient } from "@/lib/events";
import type { SseEventData } from "@/lib/events";

/**
 * Details of a failed SSE snapshot, mirroring the
 * `snapshot_unavailable` event payload.
 */
export type SnapshotError = SseEventData<"snapshot_unavailable">;

type ConnectionState = {
  /**
   * Set when the server sent `snapshot_unavailable` instead of a
   * snapshot; cleared when a snapshot arrives.
   */
  snapshotError: SnapshotError | null;
};

export const useConnectionStore = create<ConnectionState>(() => ({
  snapshotError: null,
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

export function initializeConnectionStore(): void {
  if (initialized) return;
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot_unavailable", (data) => {
      useConnectionStore.setState({ snapshotError: data });
    }),
    events.on("snapshot", () => {
      useConnectionStore.setState({ snapshotError: null });
    }),
  ];
}

/**
 * Reconnects the SSE stream so the server rebuilds the snapshot. On
 * success the incoming snapshot clears `snapshotError`; on failure the
 * server sends a fresh `snapshot_unavailable`.
 */
export function retrySnapshot(): void {
  const events = getEventClient();
  events.disconnect();
  events.connect();
}

export function resetConnectionStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useConnectionStore.setState({ snapshotError: null });
}
