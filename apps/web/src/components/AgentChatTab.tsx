import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ChevronDown,
  LoaderCircle,
  MessageSquareText,
  SendHorizontal,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatStore } from "@/lib/stores/chats";
import type {
  AgentChatTab,
  ChatMessage,
  ChatModelOption,
  ChatPermissionMode,
  ChatReasoningEffort,
  ChatRuntimeLifecycle,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  tab: AgentChatTab;
  visible: boolean;
};

function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.contentText }],
  };
}

function isRuntimeRunning(
  lifecycle: ChatRuntimeLifecycle | undefined,
): boolean {
  return lifecycle === "starting" || lifecycle === "running";
}

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

function ThinkingBlock({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  const hasReasoning = message.reasoningText.trim().length > 0;
  const [collapsed, setCollapsed] = useState(false);
  const open = (streaming || hasReasoning) && !collapsed;

  if (!hasReasoning && !streaming) {
    return null;
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => setCollapsed(!nextOpen)}
    >
      <div className="rounded-lg border bg-muted/35">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
          <div>
            <div className="text-xs font-medium text-foreground">Thinking</div>
            <div className="text-xs text-muted-foreground">
              {streaming ? "Streaming reasoning summary" : "Reasoning summary"}
            </div>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-3 py-3">
          <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
            {hasReasoning
              ? message.reasoningText
              : "Waiting for reasoning summary…"}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function UserTurn({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(42rem,82%)] rounded-2xl border bg-muted/30 px-4 py-3">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          You
        </div>
        <div className="whitespace-pre-wrap text-sm leading-6">
          {message.contentText}
        </div>
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[min(46rem,92%)] space-y-3 rounded-2xl border bg-card px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageSquareText className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-sm font-medium">Codex</div>
            <div className="text-xs text-muted-foreground">
              {streaming ? "Responding" : "Response ready"}
            </div>
          </div>
        </div>
        <ThinkingBlock message={message} streaming={streaming} />
        <div className="whitespace-pre-wrap text-sm leading-6">
          {message.contentText || (streaming ? "Working…" : "")}
        </div>
      </div>
    </div>
  );
}

export default function AgentChatTabView({ tab, visible }: Props) {
  const detailState = useChatStore(
    (state) => state.detailsByConversationId[tab.conversation_id],
  );
  const runtimeStatus = useChatStore(
    (state) => state.runtimesByConversationId[tab.conversation_id],
  );
  const modelOptions = useChatStore((state) => state.modelOptions);
  const modelOptionsStatus = useChatStore((state) => state.modelOptionsStatus);
  const modelOptionsError = useChatStore((state) => state.modelOptionsError);
  const ensureConversationLoaded = useChatStore(
    (state) => state.ensureConversationLoaded,
  );
  const ensureModelsLoaded = useChatStore((state) => state.ensureModelsLoaded);
  const refreshConversation = useChatStore(
    (state) => state.refreshConversation,
  );
  const sendMessage = useChatStore((state) => state.sendMessage);
  const interruptRun = useChatStore((state) => state.interruptRun);
  const updateConversationSettings = useChatStore(
    (state) => state.updateConversationSettings,
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    void ensureConversationLoaded(tab.conversation_id);
    void ensureModelsLoaded();
  }, [
    ensureConversationLoaded,
    ensureModelsLoaded,
    tab.conversation_id,
    visible,
  ]);

  useEffect(() => {
    if (!visible || !detailState?.needsRefresh) {
      return;
    }
    void refreshConversation(tab.conversation_id);
  }, [
    detailState?.needsRefresh,
    refreshConversation,
    tab.conversation_id,
    visible,
  ]);

  const conversation = detailState?.detail?.conversation;
  const messages = detailState?.detail?.messages ?? [];
  const runtimeMessages = messages.map(toThreadMessage);
  const hasStreamingMessage = messages.some(
    (message) => message.role === "assistant" && message.status === "streaming",
  );
  const isRunning = isRuntimeRunning(runtimeStatus?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
  const runtimeLabel = runtimeStatusLabel(runtimeStatus?.lifecycle);
  const latestError =
    runtimeStatus?.lastError ??
    detailState?.detail?.latestRun?.errorMessage ??
    conversation?.lastError ??
    detailState?.error ??
    modelOptionsError;

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
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!text) {
        return;
      }
      await sendMessage(tab.conversation_id, text);
    },
    onCancel: async () => {
      await interruptRun(tab.conversation_id);
    },
  });

  const handleModelChange = async (modelValue: string) => {
    const nextModel = modelOptions.find(
      (option) => option.model === modelValue,
    );
    await updateConversationSettings(tab.conversation_id, {
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
    await updateConversationSettings(tab.conversation_id, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: effort as ChatReasoningEffort,
      selectedPermissionMode: conversation?.selectedPermissionMode ?? null,
    });
  };

  const handlePermissionChange = async (permissionMode: string) => {
    await updateConversationSettings(tab.conversation_id, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: selectedEffort ?? null,
      selectedPermissionMode:
        permissionMode === "default"
          ? null
          : (permissionMode as ChatPermissionMode),
    });
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{tab.label}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
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
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex min-h-[28vh] flex-col items-center justify-center px-6 text-center">
                <div className="rounded-full bg-primary/10 p-3 text-primary">
                  <MessageSquareText className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-base font-medium">New Chat</h3>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  Ask Codex about this worktree. History comes from Hubris
                  state, while model and effort settings apply to future turns.
                </p>
              </div>
            ) : (
              messages.map((message) =>
                message.role === "user" ? (
                  <UserTurn key={message.id} message={message} />
                ) : (
                  <AssistantTurn
                    key={message.id}
                    message={message}
                    streaming={message.status === "streaming"}
                  />
                ),
              )
            )}
          </div>
        </ScrollArea>

        <div className="border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            <ComposerPrimitive.Root className="flex flex-col gap-3">
              <ComposerPrimitive.Input
                className="min-h-14 max-h-40 w-full resize-none rounded-xl border bg-card px-3 py-2 text-sm outline-none ring-0 placeholder:text-muted-foreground focus-visible:border-ring"
                placeholder="Ask Codex about this worktree"
                submitMode="enter"
              />
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={selectedPermissionMode}
                    onValueChange={handlePermissionChange}
                  >
                    <SelectTrigger size="sm" className="bg-card">
                      <SelectValue placeholder="Permissions">
                        {permissionLabel(selectedPermissionMode)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="default">
                        Default permissions
                      </SelectItem>
                      <SelectItem value="full_access">Full access</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    disabled={modelOptionsStatus !== "loaded"}
                    value={selectedModel?.model}
                    onValueChange={handleModelChange}
                  >
                    <SelectTrigger size="sm" className="bg-card">
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
                    disabled={!selectedModel || supportedEfforts.length === 0}
                    value={selectedEffort}
                    onValueChange={handleEffortChange}
                  >
                    <SelectTrigger size="sm" className="bg-card">
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
                      aria-label="Send message"
                      title="Send message"
                    >
                      <SendHorizontal className="h-4 w-4" />
                    </ComposerPrimitive.Send>
                  )}
                </div>
              </div>
            </ComposerPrimitive.Root>
          </div>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
