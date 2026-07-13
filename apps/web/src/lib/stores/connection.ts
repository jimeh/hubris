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
let reloadedForBuildMismatch = false;
let eventUnsubscribers: Array<() => void> = [];

type BuildIdHandshakeOptions = {
  clientBuildId?: string;
  reload?: () => void;
};

/** Return whether a snapshot should trigger the one-time upgrade reload. */
export function shouldReloadForBuildMismatch(
  clientBuildId: string | undefined,
  serverBuildId: string | undefined,
  hasReloaded: boolean,
): boolean {
  return Boolean(
    clientBuildId &&
    serverBuildId &&
    clientBuildId !== serverBuildId &&
    !hasReloaded,
  );
}

export function initializeConnectionStore(
  options: BuildIdHandshakeOptions = {},
): void {
  if (initialized) return;
  initialized = true;

  const clientBuildId =
    options.clientBuildId ?? import.meta.env.HUBRIS_BUILD_ID;
  const reload = options.reload ?? (() => window.location.reload());

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot_unavailable", (data) => {
      useConnectionStore.setState({ snapshotError: data });
    }),
    events.on("snapshot", (data) => {
      if (
        shouldReloadForBuildMismatch(
          clientBuildId,
          data.buildId,
          reloadedForBuildMismatch,
        )
      ) {
        reloadedForBuildMismatch = true;
        reload();
      }
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
  reloadedForBuildMismatch = false;
  useConnectionStore.setState({ snapshotError: null });
}
