import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ChevronDown,
  FilePenLine,
  LoaderCircle,
  MessageSquareText,
  SendHorizontal,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
import {
  selectChatComposerMessages,
  selectChatActivityDetailState,
  selectChatDetailState,
  selectChatHeaderSlice,
  selectChatItem,
  selectChatItemOutput,
  selectChatItemOutputIds,
  selectChatMessage,
  selectChatModelSlice,
  selectChatTimelineIds,
  useChatStore,
} from "@/lib/stores/chats";
import type {
  AgentChatTab,
  ChatItem,
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

const convertThreadMessage = (message: ThreadMessageLike) => message;

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

function assistantStatusLabel(
  message: ChatMessage,
  streaming: boolean,
): string {
  if (streaming) {
    return "Responding";
  }

  if (message.status === "completed" && !message.contentText.trim()) {
    return "No response";
  }

  switch (message.status) {
    case "failed":
      return "Response failed";
    case "interrupted":
      return "Response interrupted";
    case "pending":
      return "Pending";
    default:
      return "Response ready";
  }
}

function assistantFallbackText(
  message: ChatMessage,
  streaming: boolean,
): string {
  if (streaming) {
    return "Working...";
  }

  if (message.status === "completed" && !message.contentText.trim()) {
    return "Codex completed without returning a response.";
  }

  switch (message.status) {
    case "failed":
      return "Codex stopped before returning a response.";
    case "interrupted":
      return "Response interrupted before Codex returned text.";
    default:
      return "";
  }
}

function activityLabel(item: ChatItem): string {
  if (item.title) {
    return item.title;
  }
  switch (item.kind) {
    case "command_execution":
      return "Run command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "View image";
    case "hook":
      return "Run hook";
    case "auto_approval_review":
      return "Permission review";
    case "model_reroute":
      return "Model rerouted";
    default:
      return "Activity";
  }
}

function activityStatusLabel(item: ChatItem): string {
  switch (item.status) {
    case "started":
      return "Started";
    case "streaming":
      return "Running";
    case "failed":
      return "Failed";
    default:
      return "Completed";
  }
}

function ActivityIcon({ item }: { item: ChatItem }) {
  const className = "h-3.5 w-3.5";
  if (item.kind === "command_execution") {
    return <Terminal className={className} />;
  }
  if (item.kind === "file_change") {
    return <FilePenLine className={className} />;
  }
  return <Wrench className={className} />;
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
  const failed = message.status === "failed";
  const interrupted = message.status === "interrupted";
  const fallbackText = assistantFallbackText(message, streaming);

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "max-w-[min(46rem,92%)] space-y-3 rounded-2xl border bg-card px-4 py-3 shadow-xs",
          failed && "border-destructive/40",
          interrupted && "border-muted-foreground/30",
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary",
              failed && "bg-destructive/10 text-destructive",
              interrupted && "bg-muted text-muted-foreground",
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-sm font-medium">Codex</div>
            <div className="text-xs text-muted-foreground">
              {assistantStatusLabel(message, streaming)}
            </div>
          </div>
        </div>
        <ThinkingBlock message={message} streaming={streaming} />
        <div
          className={cn(
            "whitespace-pre-wrap text-sm leading-6",
            !message.contentText && fallbackText && "text-muted-foreground",
            failed && "text-destructive",
          )}
        >
          {message.contentText || fallbackText}
        </div>
      </div>
    </div>
  );
}

function ChatHeader({
  conversationId,
  label,
}: {
  conversationId: string;
  label: string;
}) {
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
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
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
  );
}

function ChatMessageRow({ messageId }: { messageId: string }) {
  const message = useChatStore((state) => selectChatMessage(state, messageId));
  if (!message) {
    return null;
  }

  return message.role === "user" ? (
    <UserTurn message={message} />
  ) : (
    <AssistantTurn
      message={message}
      streaming={message.status === "streaming"}
    />
  );
}

function ActivityOutputChunk({ outputId }: { outputId: string }) {
  const output = useChatStore((state) => selectChatItemOutput(state, outputId));
  if (!output) {
    return null;
  }
  return <>{output.contentText}</>;
}

function ActivityRow({
  conversationId,
  itemId,
}: {
  conversationId: string;
  itemId: string;
}) {
  const item = useChatStore((state) => selectChatItem(state, itemId));
  const outputIds = useChatStore((state) =>
    selectChatItemOutputIds(state, itemId),
  );
  const detailState = useChatStore((state) =>
    selectChatActivityDetailState(state, itemId),
  );
  const ensureActivityLoaded = useChatStore(
    (state) => state.ensureActivityLoaded,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      void ensureActivityLoaded(conversationId, itemId);
    }
  }, [conversationId, ensureActivityLoaded, itemId, open]);

  if (!item) {
    return null;
  }

  const running = item.status === "started" || item.status === "streaming";
  const failed = item.status === "failed";
  const hasOutputs = outputIds.length > 0;

  return (
    <div className="flex justify-start">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "max-w-[min(46rem,92%)] rounded-xl border bg-muted/25 text-sm",
            failed && "border-destructive/40",
          )}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-2 text-left">
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                running && "text-primary",
                failed && "text-destructive",
              )}
            >
              {running ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ActivityIcon item={item} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{activityLabel(item)}</div>
              <div className="truncate text-xs text-muted-foreground">
                {activityStatusLabel(item)}
                {item.summary ? ` · ${item.summary}` : ""}
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
            {detailState.status === "loading" && !hasOutputs ? (
              <div className="text-xs text-muted-foreground">
                Loading activity output…
              </div>
            ) : null}
            {detailState.error ? (
              <div className="text-xs text-destructive">
                {detailState.error}
              </div>
            ) : null}
            {hasOutputs ? (
              <pre className="max-h-72 overflow-auto rounded-lg bg-background/80 p-3 text-xs leading-5 text-foreground">
                {outputIds.map((outputId) => (
                  <ActivityOutputChunk key={outputId} outputId={outputId} />
                ))}
              </pre>
            ) : detailState.status !== "loading" ? (
              <div className="text-xs text-muted-foreground">
                No output captured for this activity.
              </div>
            ) : null}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}

function ChatTimelineRow({
  conversationId,
  rowId,
}: {
  conversationId: string;
  rowId: string;
}) {
  if (rowId.startsWith("activity:")) {
    return (
      <ActivityRow
        conversationId={conversationId}
        itemId={rowId.slice("activity:".length)}
      />
    );
  }
  return <ChatMessageRow messageId={rowId.slice("message:".length)} />;
}

function ChatTranscript({ conversationId }: { conversationId: string }) {
  const timelineIds = useChatStore((state) =>
    selectChatTimelineIds(state, conversationId),
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
        {timelineIds.length === 0 ? (
          <div className="flex min-h-[28vh] flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full bg-primary/10 p-3 text-primary">
              <MessageSquareText className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-base font-medium">New Chat</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Ask Codex about this worktree. History comes from Hubris state,
              while model and effort settings apply to future turns.
            </p>
          </div>
        ) : (
          timelineIds.map((rowId) => (
            <ChatTimelineRow
              key={rowId}
              conversationId={conversationId}
              rowId={rowId}
            />
          ))
        )}
      </div>
    </ScrollArea>
  );
}

function ChatComposer({ conversationId }: { conversationId: string }) {
  const {
    conversation,
    hasStreamingMessage,
    modelOptions,
    modelOptionsStatus,
    runtime: runtimeStatus,
  } = useChatStore(
    useShallow((state) => selectChatModelSlice(state, conversationId)),
  );
  const isRunning = isRuntimeRunning(runtimeStatus?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
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
      await sendMessage(conversationId, text);
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
                    <SelectItem value="default">Default permissions</SelectItem>
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
    </AssistantRuntimeProvider>
  );
}

export default function AgentChatTabView({ tab, visible }: Props) {
  const detailState = useChatStore((state) =>
    selectChatDetailState(state, tab.conversation_id),
  );
  const ensureConversationLoaded = useChatStore(
    (state) => state.ensureConversationLoaded,
  );
  const ensureModelsLoaded = useChatStore((state) => state.ensureModelsLoaded);
  const refreshConversation = useChatStore(
    (state) => state.refreshConversation,
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
    if (!visible || !detailState.needsRefresh) {
      return;
    }
    void refreshConversation(tab.conversation_id);
  }, [
    detailState.needsRefresh,
    refreshConversation,
    tab.conversation_id,
    visible,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ChatHeader conversationId={tab.conversation_id} label={tab.label} />
      <ChatTranscript conversationId={tab.conversation_id} />
      <ChatComposer conversationId={tab.conversation_id} />
    </div>
  );
}
