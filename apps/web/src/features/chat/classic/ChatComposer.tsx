// Frozen classic renderer: no new investment; CopilotKit is the promoted default.

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@/lib/heavy/assistantUi";
import { SendHorizontal, Square } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { PendingRequestPanel } from "@/features/chat/classic/PendingRequestUi";
import { isRuntimeRunning } from "@/lib/chat/";
import {
  selectChatActivePendingRequestIds,
  selectChatComposerMessages,
  selectChatContextUsage,
  selectChatModelSlice,
  useChatStore,
} from "@/lib/stores/chats";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ChatContextUsage,
  ChatModelOption,
  ChatPermissionMode,
  ChatReasoningEffort,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const convertThreadMessage = (message: ThreadMessageLike) => message;
function effortLabel(value: ChatReasoningEffort): string {
  switch (value) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
  }
}

function permissionLabel(value: ChatPermissionMode | "default"): string {
  switch (value) {
    case "full_access":
      return "Full access";
    default:
      return "Default permissions";
  }
}

function resolveSelectedModel(
  models: readonly ChatModelOption[],
  selectedModel: string | null | undefined,
): ChatModelOption | undefined {
  if (selectedModel) {
    return models.find((model) => model.model === selectedModel);
  }
  return models.find((model) => model.isDefault) ?? models[0];
}

function resolveSelectedEffort(
  model: ChatModelOption | undefined,
  selectedEffort: ChatReasoningEffort | null | undefined,
): ChatReasoningEffort | undefined {
  if (selectedEffort) {
    return selectedEffort;
  }
  return model?.defaultReasoningEffort;
}

function contextUsageLabel(usage: ChatContextUsage | null): string {
  if (!usage) {
    return "Context";
  }
  if (typeof usage.percentUsed === "number") {
    return `${Math.round(usage.percentUsed)}% context`;
  }
  if (usage.usedTokens != null && usage.maxTokens != null) {
    return `${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()}`;
  }
  return "Context";
}

function contextUsageTitle(usage: ChatContextUsage | null): string {
  if (!usage) {
    return "Context usage has not been reported for this chat yet.";
  }
  const lines = [];
  if (usage.usedTokens != null || usage.maxTokens != null) {
    lines.push(
      `Used: ${usage.usedTokens?.toLocaleString() ?? "unknown"} / ${
        usage.maxTokens?.toLocaleString() ?? "unknown"
      } tokens`,
    );
  }
  if (usage.totalProcessedTokens != null) {
    lines.push(
      `Processed: ${usage.totalProcessedTokens.toLocaleString()} tokens`,
    );
  }
  if (usage.percentUsed != null) {
    lines.push(`Context: ${Math.round(usage.percentUsed)}%`);
  }
  return lines.join("\n") || "Context usage has been updated.";
}
function ContextUsageMeter({ conversationId }: { conversationId: string }) {
  const usage = useChatStore((state) =>
    selectChatContextUsage(state, conversationId),
  );
  const percent =
    typeof usage?.percentUsed === "number"
      ? Math.max(0, Math.min(100, usage.percentUsed))
      : null;
  return (
    <div
      role="meter"
      aria-label={contextUsageTitle(usage)}
      aria-valuemin={percent != null ? 0 : undefined}
      aria-valuemax={percent != null ? 100 : undefined}
      aria-valuenow={percent != null ? Math.round(percent) : undefined}
      className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-2 text-xs text-muted-foreground"
      title={contextUsageTitle(usage)}
    >
      <span>{contextUsageLabel(usage)}</span>
      {percent != null ? (
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full bg-primary",
              percent >= 85 && "bg-amber-500",
              percent >= 95 && "bg-destructive",
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

export function ChatComposer({
  conversationId,
  worktreeId,
}: {
  conversationId: string;
  worktreeId: string;
}) {
  const {
    conversation,
    hasStreamingMessage,
    modelOptions,
    modelOptionsStatus,
    reconciliation,
    runtime: runtimeStatus,
  } = useChatStore(
    useShallow((state) => selectChatModelSlice(state, conversationId)),
  );
  const isRunning = isRuntimeRunning(runtimeStatus?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
  const isReconciling = reconciliation?.status === "running";
  const isArchived = conversation?.archivedAt != null;
  const activePendingRequestIds = useChatStore(
    useShallow((state) =>
      selectChatActivePendingRequestIds(state, conversationId),
    ),
  );
  const hasBlockingRequest = activePendingRequestIds.length > 0;
  const runtimeMessages = selectChatComposerMessages();
  const sendMessage = useChatStore((state) => state.sendMessage);
  const interruptRun = useChatStore((state) => state.interruptRun);
  const updateConversationSettings = useChatStore(
    (state) => state.updateConversationSettings,
  );

  const selectedModel = useMemo(
    () => resolveSelectedModel(modelOptions, conversation?.selectedModel),
    [conversation?.selectedModel, modelOptions],
  );
  const selectedEffort = resolveSelectedEffort(
    selectedModel,
    conversation?.selectedEffort,
  );
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const selectedPermissionMode =
    conversation?.selectedPermissionMode ?? "default";

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages: runtimeMessages,
    convertMessage: convertThreadMessage,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!text) {
        return;
      }
      if (hasBlockingRequest || isReconciling || isArchived) {
        return;
      }
      await sendMessage(conversationId, text, worktreeId);
    },
    onCancel: async () => {
      await interruptRun(conversationId);
    },
  });

  const handleModelChange = async (modelValue: string) => {
    const nextModel = modelOptions.find(
      (option) => option.model === modelValue,
    );
    await updateConversationSettings(conversationId, {
      selectedModel: modelValue,
      selectedEffort:
        nextModel?.supportedReasoningEfforts.find(
          (option) => option.reasoningEffort === selectedEffort,
        )?.reasoningEffort ??
        nextModel?.defaultReasoningEffort ??
        null,
      selectedPermissionMode: conversation?.selectedPermissionMode ?? null,
    });
  };

  const handleEffortChange = async (effort: string) => {
    await updateConversationSettings(conversationId, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: effort as ChatReasoningEffort,
      selectedPermissionMode: conversation?.selectedPermissionMode ?? null,
    });
  };

  const handlePermissionChange = async (permissionMode: string) => {
    await updateConversationSettings(conversationId, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: selectedEffort ?? null,
      selectedPermissionMode:
        permissionMode === "default"
          ? null
          : (permissionMode as ChatPermissionMode),
    });
  };
  const sendDisabledReason = hasBlockingRequest
    ? "Codex is waiting for approval or input."
    : isReconciling
      ? "Hubris is reconciling Codex thread state."
      : isArchived
        ? "Unarchive this chat to continue."
        : undefined;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {isArchived ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This chat is archived. Unarchive it from the Chats panel to
              continue.
            </div>
          ) : null}
          <PendingRequestPanel conversationId={conversationId} />
          <ComposerPrimitive.Root className="flex flex-col gap-3">
            <ComposerPrimitive.Input
              aria-label="Message Codex"
              data-chat-composer-input="true"
              className="min-h-14 max-h-40 w-full resize-none rounded-xl border bg-card px-3 py-2 text-sm outline-none ring-0 placeholder:text-muted-foreground focus-visible:border-ring"
              disabled={isArchived}
              placeholder={
                isArchived
                  ? "Unarchive this chat to continue"
                  : "Ask Codex about this worktree"
              }
              submitMode="enter"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  disabled={isArchived}
                  value={selectedPermissionMode}
                  onValueChange={handlePermissionChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex permissions"
                  >
                    <SelectValue placeholder="Permissions">
                      {permissionLabel(selectedPermissionMode)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="default">Default permissions</SelectItem>
                    <SelectItem value="full_access">Full access</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  disabled={isArchived || modelOptionsStatus !== "loaded"}
                  value={selectedModel?.model}
                  onValueChange={handleModelChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex model"
                  >
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {modelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.model}>
                        {model.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  disabled={
                    isArchived ||
                    !selectedModel ||
                    supportedEfforts.length === 0
                  }
                  value={selectedEffort}
                  onValueChange={handleEffortChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex reasoning effort"
                  >
                    <SelectValue placeholder="Effort" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {supportedEfforts.map((option) => (
                      <SelectItem
                        key={option.reasoningEffort}
                        value={option.reasoningEffort}
                      >
                        {effortLabel(option.reasoningEffort)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <ContextUsageMeter conversationId={conversationId} />
              </div>

              <div className="flex items-center">
                {isRunActive ? (
                  <ComposerPrimitive.Cancel
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted"
                    aria-label="Interrupt run"
                    title="Interrupt run"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    disabled={hasBlockingRequest || isReconciling || isArchived}
                    aria-disabled={
                      hasBlockingRequest || isReconciling || isArchived
                    }
                    aria-label="Send message"
                    title={sendDisabledReason ?? "Send message"}
                  >
                    <SendHorizontal className="h-4 w-4" />
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
