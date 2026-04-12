import { create } from "zustand";
import type { VscodeStatus as RestVscodeStatus } from "@/lib/api";
import type { VscodeStatus as SseVscodeStatus } from "@/lib/contracts/sse.generated";
import { getEventClient } from "@/lib/events";

type VscodeStatus = RestVscodeStatus;
type RawVscodeStatus = RestVscodeStatus | SseVscodeStatus;

type VscodeStoreState = {
  status: VscodeStatus | null;
};

export const useVscodeStore = create<VscodeStoreState>(() => ({
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

function normalizeRuntimeStatus(status: RawVscodeStatus["codeServer"]) {
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
    activeTaskId: status.activeTaskId,
  };
}

function normalizeVscodeStatus(status: RawVscodeStatus): VscodeStatus {
  return {
    selectedRuntime: status.selectedRuntime,
    codeServer: normalizeRuntimeStatus(status.codeServer),
    vscodeCli: normalizeRuntimeStatus(status.vscodeCli),
  };
}

export function initializeVscodeStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      useVscodeStore.setState({
        status: normalizeVscodeStatus(data.vscode),
      });
    }),
    events.on("vscode_updated", (data) => {
      useVscodeStore.setState({ status: normalizeVscodeStatus(data) });
    }),
  ];
}

export function setVscodeStatus(status: RawVscodeStatus): void {
  useVscodeStore.setState({ status: normalizeVscodeStatus(status) });
}

export function resetVscodeStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useVscodeStore.setState({ status: null });
}
