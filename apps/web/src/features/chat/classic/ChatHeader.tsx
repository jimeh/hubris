// Frozen classic renderer: no new investment; CopilotKit is the promoted default.

import { LoaderCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { isRuntimeRunning } from "@/lib/chat/";
import {
  selectChatHeaderSlice,
  selectChatReconciliation,
  useChatStore,
} from "@/lib/stores/chats";
import { useChatSettings } from "@/lib/stores/chatSettings";
import type { ChatReconciliation, ChatRuntimeLifecycle } from "@/lib/types";

function runtimeStatusLabel(
  lifecycle: ChatRuntimeLifecycle | undefined,
): string {
  switch (lifecycle) {
    case "starting":
      return "Starting Codex";
    case "ready":
      return "Warm";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Runtime failed";
    default:
      return "Idle";
  }
}

function reconciliationStatusText(
  reconciliation: ChatReconciliation | null,
): string | null {
  switch (reconciliation?.status) {
    case "pending":
      return "Codex disconnected before this turn completed. Hubris will reconcile the transcript when the thread resumes.";
    case "running":
      return "Reconciling Codex thread state. Existing transcript remains visible while Hubris verifies provider state.";
    case "failed":
      return reconciliation.errorMessage
        ? `Reconciliation failed: ${reconciliation.errorMessage}`
        : "Reconciliation failed. Partial transcript was preserved and future sends are allowed.";
    default:
      return null;
  }
}

export function ChatHeader({
  conversationId,
  label,
}: {
  conversationId: string;
  label: string;
}) {
  const updateChatSettings = useChatSettings((state) => state.updateSettings);
  const {
    conversation,
    detailError,
    hasStreamingMessage,
    latestRun,
    modelOptionsError,
    runtime,
  } = useChatStore(
    useShallow((state) => selectChatHeaderSlice(state, conversationId)),
  );
  const isRunning = isRuntimeRunning(runtime?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
  const runtimeLabel = runtimeStatusLabel(runtime?.lifecycle);
  const latestError =
    runtime?.lastError ??
    latestRun?.errorMessage ??
    conversation?.lastError ??
    detailError ??
    modelOptionsError;

  return (
    <div
      className="flex items-center justify-between gap-3 border-b px-4 py-3"
      aria-label="Chat header"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div
          className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {isRunActive ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          <span>{runtimeLabel}</span>
        </div>
      </div>
      {latestError ? (
        <div className="max-w-xs truncate text-xs text-destructive">
          {latestError}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => updateChatSettings({ uiStyle: "copilotkit" })}
      >
        CopilotKit
      </Button>
    </div>
  );
}

export function ReconciliationBanner({
  conversationId,
}: {
  conversationId: string;
}) {
  const reconciliation = useChatStore((state) =>
    selectChatReconciliation(state, conversationId),
  );
  const text = reconciliationStatusText(reconciliation);
  if (!text) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
    >
      <div className="mx-auto max-w-3xl">{text}</div>
    </div>
  );
}
