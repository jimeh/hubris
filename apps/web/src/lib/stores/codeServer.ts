import { create } from "zustand";
import type { CodeServerStatus as RestCodeServerStatus } from "@/lib/api";
import type { CodeServerStatus as SseCodeServerStatus } from "@/lib/contracts/sse.generated";
import { getEventClient } from "@/lib/events";

type CodeServerStatus = RestCodeServerStatus;
type RawCodeServerStatus = RestCodeServerStatus | SseCodeServerStatus;

type CodeServerStoreState = {
  status: CodeServerStatus | null;
};

export const useCodeServerStore = create<CodeServerStoreState>(() => ({
  status: null,
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

function normalizeBytes(
  value: bigint | number | null | undefined,
): number | null | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

function normalizeCodeServerStatus(
  status: RawCodeServerStatus,
): CodeServerStatus {
  return {
    supported: status.supported,
    installedVersion: status.installedVersion,
    processStatus: status.processStatus,
    latest: status.latest
      ? {
          latestVersion: status.latest.latestVersion,
          updateAvailable: status.latest.updateAvailable,
          checkedAt: status.latest.checkedAt,
        }
      : null,
    installProgress: status.installProgress
      ? {
          phase: status.installProgress.phase,
          percent: status.installProgress.percent,
          downloadedBytes: normalizeBytes(
            status.installProgress.downloadedBytes,
          ),
          totalBytes: normalizeBytes(status.installProgress.totalBytes),
        }
      : null,
    message: status.message,
  };
}

export function initializeCodeServerStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      useCodeServerStore.setState({
        status: normalizeCodeServerStatus(data.code_server),
      });
    }),
    events.on("code_server_updated", (data) => {
      useCodeServerStore.setState({ status: normalizeCodeServerStatus(data) });
    }),
  ];
}

export function setCodeServerStatus(status: RawCodeServerStatus): void {
  useCodeServerStore.setState({ status: normalizeCodeServerStatus(status) });
}

export function resetCodeServerStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useCodeServerStore.setState({ status: null });
}
