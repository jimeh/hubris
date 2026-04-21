import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  LoaderCircle,
  MessageSquareText,
  SendHorizontal,
  Square,
} from "lucide-react";
import { useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useChatStore } from "@/lib/stores/chats";
import type {
  AgentChatTab,
  ChatMessage,
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
      return "Codex warm";
    case "running":
      return "Responding";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Runtime failed";
    default:
      return "Idle";
  }
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      data-role="user"
      className="flex justify-end px-4 py-2"
    >
      <div className="max-w-[min(48rem,85%)] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
        <MessagePrimitive.Parts>
          {({ part }) =>
            part.type === "text" ? (
              <p className="whitespace-pre-wrap leading-relaxed">
                <MessagePartPrimitive.Text />
              </p>
            ) : null
          }
        </MessagePrimitive.Parts>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="flex gap-3 px-4 py-2"
    >
      <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MessageSquareText className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[min(48rem,85%)] rounded-2xl border bg-card px-4 py-2.5 text-sm shadow-xs">
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === "text") {
              return (
                <div className="whitespace-pre-wrap leading-relaxed">
                  <MessagePartPrimitive.Text />
                </div>
              );
            }
            return null;
          }}
        </MessagePrimitive.Parts>
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root
            className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <ErrorPrimitive.Message />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  );
}

export default function AgentChatTabView({ tab, visible }: Props) {
  const detailState = useChatStore(
    (state) => state.detailsByConversationId[tab.conversation_id],
  );
  const runtimeStatus = useChatStore(
    (state) => state.runtimesByConversationId[tab.conversation_id],
  );
  const ensureConversationLoaded = useChatStore(
    (state) => state.ensureConversationLoaded,
  );
  const refreshConversation = useChatStore(
    (state) => state.refreshConversation,
  );
  const sendMessage = useChatStore((state) => state.sendMessage);
  const interruptRun = useChatStore((state) => state.interruptRun);

  useEffect(() => {
    if (!visible) {
      return;
    }
    void ensureConversationLoaded(tab.conversation_id);
  }, [ensureConversationLoaded, tab.conversation_id, visible]);

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

  const messages = detailState?.detail?.messages ?? [];
  const runtimeMessages = messages.map(toThreadMessage);
  const isRunning = isRuntimeRunning(runtimeStatus?.lifecycle);
  const runtimeLabel = runtimeStatusLabel(runtimeStatus?.lifecycle);
  const latestError =
    runtimeStatus?.lastError ??
    detailState?.detail?.latestRun?.errorMessage ??
    detailState?.detail?.conversation.lastError ??
    detailState?.error ??
    null;

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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{tab.label}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {isRunning ? (
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
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <AuiIf condition={(state) => state.thread.isEmpty}>
                <div className="flex min-h-[40vh] flex-col items-center justify-center px-6 text-center">
                  <div className="rounded-full bg-primary/10 p-3 text-primary">
                    <MessageSquareText className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-base font-medium">New Chat</h3>
                  <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    Ask Codex about this worktree. Hubris restores the
                    transcript directly from backend state, so reading history
                    does not require a live runtime.
                  </p>
                </div>
              </AuiIf>
              <ThreadPrimitive.Messages
                components={{
                  UserMessage,
                  AssistantMessage,
                }}
              />
            </ScrollArea>
            <ThreadPrimitive.ViewportFooter className="border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
              <ComposerPrimitive.Root className="flex items-end gap-2">
                <ComposerPrimitive.Input
                  className="min-h-11 flex-1 resize-none rounded-xl border bg-card px-3 py-2 text-sm outline-none ring-0 placeholder:text-muted-foreground focus-visible:border-ring"
                  placeholder="Ask Codex about this worktree"
                  submitMode="enter"
                />
                <ComposerPrimitive.Cancel
                  className={cn(
                    "inline-flex h-10 w-10 items-center justify-center rounded-xl border text-muted-foreground transition-colors",
                    isRunning
                      ? "border-border hover:bg-muted"
                      : "pointer-events-none opacity-40",
                  )}
                  aria-label="Interrupt run"
                  title="Interrupt run"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </ComposerPrimitive.Cancel>
                <ComposerPrimitive.Send
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                  aria-label="Send message"
                  title="Send message"
                >
                  <SendHorizontal className="h-4 w-4" />
                </ComposerPrimitive.Send>
              </ComposerPrimitive.Root>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}
