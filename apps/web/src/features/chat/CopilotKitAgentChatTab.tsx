import {
  CopilotChat,
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatReasoningMessage,
  CopilotKitProvider,
  HttpAgent,
  useRenderActivityMessage,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
  type ReactActivityMessageRenderer,
  type Message,
} from "@copilotkit/react-core/v2";
import {
  AlertCircle,
  ChevronRight,
  LoaderCircle,
  MessageSquareText,
  Wrench,
} from "lucide-react";
import {
  createContext,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { codexAgUiChatUrl } from "@/lib/api";
import { isRuntimeRunning } from "@/lib/chat/";
import { useChatSettings } from "@/lib/stores/chatSettings";
import {
  selectChatDiffSummary,
  selectChatConversation,
  selectChatDetailState,
  selectChatHeaderSlice,
  selectChatItem,
  selectChatMessage,
  selectChatPendingRequest,
  selectChatPlan,
  selectChatTimelineIds,
  selectChatWorkGroupSlice,
  useChatStore,
} from "@/lib/stores/chats";
import { useSettingsStore } from "@/lib/stores/settings";
import type {
  AgentChatTab,
  ChatDiffSummary,
  ChatItem,
  ChatMessage,
  ChatPendingRequest,
  ChatPlan,
} from "@/lib/types";

type Props = {
  tab: AgentChatTab;
  visible: boolean;
};

type ChatStoreSnapshot = Parameters<typeof selectChatTimelineIds>[0];

type ActivityMessage = Extract<Message, { role: "activity" }>;
type ReasoningMessage = Extract<Message, { role: "reasoning" }>;
type WorkMessage = ActivityMessage | ReasoningMessage;

type WorkMessageBlock = {
  message: ReasoningMessage;
  activities: ActivityMessage[];
  workMessages: WorkMessage[];
  nextIndex: number;
};

const HubrisRunningContext = createContext(false);

type CodexActivityContent = {
  id?: string;
  kind?: string;
  status?: string;
  title?: string;
  summary?: string;
  method?: string;
  content?: string;
  changedFileCount?: number;
  files?: unknown;
  payload?: unknown;
  metadata?: unknown;
  sequence?: number;
};

const codexActivityContentSchema = {
  safeParse(value: unknown) {
    return {
      success: true,
      data: normalizeActivityContent(value),
    };
  },
} as unknown as ReactActivityMessageRenderer<CodexActivityContent>["content"];

const codexActivityRenderers = [
  {
    activityType: "*",
    agentId: "codex",
    content: codexActivityContentSchema,
    render: CodexActivityMessage,
  },
] satisfies ReactActivityMessageRenderer<CodexActivityContent>[];

function hubrisMessageToAgUi(message: ChatMessage): Message {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: message.contentText,
    };
  }

  if (!message.contentText.trim() && message.reasoningText.trim()) {
    return {
      id: message.id,
      role: "reasoning",
      content: message.reasoningText,
    };
  }

  return {
    id: message.id,
    role: "assistant",
    content: message.contentText,
  };
}

function reasoningItemToAgUi(item: ChatItem): Message | null {
  const content = (item.summary ?? item.title ?? "").trim();
  if (!content) {
    return null;
  }
  return {
    id: item.id,
    role: "reasoning",
    content,
  };
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function activityMessage(
  id: string,
  activityType: string,
  content: CodexActivityContent,
): Message {
  return {
    id,
    role: "activity",
    activityType,
    content,
  };
}

function chatItemToActivityMessage(item: ChatItem): Message {
  return activityMessage(item.id, `codex.${item.kind}`, {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title ?? undefined,
    summary: item.summary ?? undefined,
    metadata: parseJson(item.metadataJson),
    sequence: item.sequence,
  });
}

function pendingRequestToActivityMessage(request: ChatPendingRequest): Message {
  return activityMessage(request.id, `codex.pending_request.${request.kind}`, {
    id: request.id,
    kind: request.kind,
    status: request.status,
    title: "Codex request",
    summary: request.method,
    method: request.method,
    payload: parseJson(request.payloadJson),
    sequence: request.sequence,
  });
}

function planToActivityMessage(plan: ChatPlan): Message {
  return activityMessage(plan.id, "codex.plan", {
    id: plan.id,
    kind: plan.kind,
    status: plan.status,
    title: "Plan",
    content: plan.contentText,
    metadata: parseJson(plan.metadataJson),
    sequence: plan.sequence,
  });
}

function diffSummaryToActivityMessage(diff: ChatDiffSummary): Message {
  return activityMessage(diff.id, "codex.diff", {
    id: diff.id,
    status: "completed",
    title: "Changes",
    changedFileCount: diff.changedFileCount,
    files: diff.files,
    metadata: parseJson(diff.metadataJson),
    sequence: diff.sequence,
  });
}

function initialMessagesSignature(
  state: ChatStoreSnapshot,
  conversationId: string,
): string {
  return buildInitialMessages(state, conversationId)
    .map((message) =>
      JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
      }),
    )
    .join("|");
}

function buildInitialMessages(
  state: ChatStoreSnapshot,
  conversationId: string,
): Message[] {
  const messages: Message[] = [];

  for (const rowId of selectChatTimelineIds(state, conversationId)) {
    if (rowId.startsWith("message:user:")) {
      const id = rowId.slice("message:user:".length);
      const message = selectChatMessage(state, id);
      if (message) {
        messages.push(hubrisMessageToAgUi(message));
      }
      continue;
    }
    if (rowId.startsWith("message:assistant:")) {
      const id = rowId.slice("message:assistant:".length);
      const message = selectChatMessage(state, id);
      if (message) {
        messages.push(hubrisMessageToAgUi(message));
      }
      continue;
    }
    if (rowId.startsWith("activity:")) {
      const item = selectChatItem(state, rowId.slice("activity:".length));
      if (item) {
        messages.push(chatItemToActivityMessage(item));
      }
      continue;
    }
    if (rowId.startsWith("request:")) {
      const request = selectChatPendingRequest(
        state,
        rowId.slice("request:".length),
      );
      if (request) {
        messages.push(pendingRequestToActivityMessage(request));
      }
      continue;
    }
    if (rowId.startsWith("plan:")) {
      const plan = selectChatPlan(state, rowId.slice("plan:".length));
      if (plan) {
        messages.push(planToActivityMessage(plan));
      }
      continue;
    }
    if (rowId.startsWith("diff:")) {
      const diff = selectChatDiffSummary(state, rowId.slice("diff:".length));
      if (diff) {
        messages.push(diffSummaryToActivityMessage(diff));
      }
      continue;
    }
    if (rowId.startsWith("work:")) {
      const [, turnId, ...segmentParts] = rowId.split(":");
      if (!turnId) {
        continue;
      }
      const work = selectChatWorkGroupSlice(
        state,
        conversationId,
        turnId,
        segmentParts.join(":") || undefined,
      );
      const reasoning =
        work.reasoningItem != null
          ? reasoningItemToAgUi(work.reasoningItem)
          : work.reasoningMessage
            ? hubrisMessageToAgUi(work.reasoningMessage)
            : null;
      if (reasoning) {
        messages.push(reasoning);
      }
      for (const id of work.activityIds) {
        const item = selectChatItem(state, id);
        if (item) {
          messages.push(chatItemToActivityMessage(item));
        }
      }
      for (const id of work.pendingRequestIds) {
        const request = selectChatPendingRequest(state, id);
        if (request) {
          messages.push(pendingRequestToActivityMessage(request));
        }
      }
      for (const id of work.planIds) {
        const plan = selectChatPlan(state, id);
        if (plan) {
          messages.push(planToActivityMessage(plan));
        }
      }
      for (const id of work.diffSummaryIds) {
        const diff = selectChatDiffSummary(state, id);
        if (diff) {
          messages.push(diffSummaryToActivityMessage(diff));
        }
      }
    }
  }

  return messages;
}

// The version argument is unused directly: it exists so callers memoizing
// on this call re-read the store whenever the message signature changes.
// A `void version` statement inside a useMemo body is NOT enough — React
// Compiler infers dependencies from real data flow and drops dead code.
function readInitialMessages(
  conversationId: string,
  _version: string,
): Message[] {
  return buildInitialMessages(useChatStore.getState(), conversationId);
}

function normalizeActivityContent(value: unknown): CodexActivityContent {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as CodexActivityContent;
}

function metadataRecord(
  content: CodexActivityContent,
): Record<string, unknown> {
  const metadata = content.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  return metadata as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function titleFromActivity(
  activityType: string,
  content: CodexActivityContent,
): string {
  const kind = content.kind ?? activityType.replace(/^codex\./, "");
  return (
    content.title ??
    {
      command_execution: "Command",
      file_change: "File change",
      mcp_tool_call: "MCP tool",
      dynamic_tool_call: "Tool call",
      web_search: "Web search",
      image_view: "Image view",
      hook: "Hook",
      auto_approval_review: "Permission review",
      model_reroute: "Model reroute",
      active_task: "Task",
      proposed_plan: "Plan",
    }[kind] ??
    kind.replaceAll("_", " ")
  );
}

function detailLines(content: CodexActivityContent): string[] {
  const metadata = metadataRecord(content);
  const lines = [
    stringValue(metadata.command),
    stringValue(metadata.cwd),
    stringValue(metadata.path),
    stringValue(metadata.toolName),
    stringValue(metadata.serverName),
    stringValue(content.method),
  ].filter((line): line is string => Boolean(line));
  const exitCode = numberValue(metadata.exitCode);
  if (exitCode !== null) {
    lines.push(`exit ${exitCode}`);
  }
  if (content.changedFileCount != null) {
    lines.push(`${content.changedFileCount} changed files`);
  }
  if (Array.isArray(content.files)) {
    lines.push(
      ...content.files
        .map((file) =>
          file && typeof file === "object" && "path" in file
            ? stringValue(file.path)
            : null,
        )
        .filter((line): line is string => Boolean(line))
        .slice(0, 3),
    );
  }
  return [...new Set(lines)].slice(0, 4);
}

function CodexActivityMessage({
  activityType,
  content,
}: {
  activityType: string;
  content: CodexActivityContent;
}) {
  const [open, setOpen] = useState(false);
  const title = titleFromActivity(activityType, content);
  const summary = content.summary ?? content.content ?? null;
  const lines = detailLines(content);

  return (
    <div className="w-full rounded-md border bg-muted/35 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {title}
        </span>
        {content.status ? (
          <span className="shrink-0 text-[10px] uppercase">
            {content.status}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t px-3 py-2">
          {summary ? (
            <div className="whitespace-pre-wrap break-words">{summary}</div>
          ) : null}
          {lines.length > 0 ? (
            <dl className="mt-2 grid gap-1">
              {lines.map((line) => (
                <div key={line} className="min-w-0 truncate">
                  {line}
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : summary ? (
        <div className="px-3 pb-2 pl-12">
          <div className="line-clamp-1 break-words">{summary}</div>
        </div>
      ) : null}
    </div>
  );
}

function isActivityMessage(message: Message): message is ActivityMessage {
  return message.role === "activity";
}

function isReasoningMessage(message: Message): message is ReasoningMessage {
  return message.role === "reasoning";
}

function isWorkMessage(message: Message): message is WorkMessage {
  return isReasoningMessage(message) || isActivityMessage(message);
}

function collectFollowingWorkMessages(
  messages: readonly Message[],
  startIndex: number,
): {
  activities: ActivityMessage[];
  reasonings: ReasoningMessage[];
  workMessages: WorkMessage[];
  nextIndex: number;
} {
  const activities: ActivityMessage[] = [];
  const reasonings: ReasoningMessage[] = [];
  const workMessages: WorkMessage[] = [];
  let index = startIndex;
  while (index < messages.length) {
    const message = messages[index];
    if (!message || !isWorkMessage(message)) {
      break;
    }
    workMessages.push(message);
    if (isReasoningMessage(message)) {
      reasonings.push(message);
    } else {
      activities.push(message);
    }
    index += 1;
  }
  return { activities, reasonings, workMessages, nextIndex: index };
}

function codexWorkBlock(
  messages: readonly Message[],
  startIndex: number,
): WorkMessageBlock {
  const { activities, reasonings, workMessages, nextIndex } =
    collectFollowingWorkMessages(messages, startIndex);
  const first = reasonings[0] ?? activities[0];
  const content = reasonings
    .map((reasoning) => reasoning.content.trim())
    .filter(Boolean)
    .join("\n\n");

  return {
    message: {
      id: first?.id ? `work-reasoning-${first.id}` : "work-reasoning-pending",
      role: "reasoning",
      content: content || " ",
    },
    activities,
    workMessages,
    nextIndex,
  };
}

function elementForMessage(
  elementsByMessageId: Map<string, ReactElement>,
  message: Message,
): ReactElement | null {
  return elementsByMessageId.get(message.id) ?? null;
}

function CodexActivityList({
  activities,
}: {
  activities: readonly ActivityMessage[];
}) {
  const { renderActivityMessage } = useRenderActivityMessage();

  if (activities.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1.5">
      {activities.map((activity) => (
        <div key={activity.id}>{renderActivityMessage(activity)}</div>
      ))}
    </div>
  );
}

function CodexReasoningContent({
  activities,
  workMessages,
  isStreaming,
  hasContent,
  className,
  children,
  ...props
}: {
  activities: readonly ActivityMessage[];
  workMessages?: readonly WorkMessage[];
  isStreaming?: boolean;
  hasContent?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const { renderActivityMessage } = useRenderActivityMessage();
  const content = typeof children === "string" ? children : "";
  const hasWorkContent =
    workMessages?.some((message) =>
      isReasoningMessage(message) ? message.content.trim().length > 0 : true,
    ) ?? false;
  const hasReasoningContent =
    (hasContent && content.trim().length > 0) || hasWorkContent;

  if (!hasReasoningContent && activities.length === 0 && !isStreaming) {
    return null;
  }

  return (
    <div className={`pb-2 pt-1 ${className ?? ""}`} {...props}>
      <div className="text-sm text-muted-foreground">
        {workMessages ? (
          <div className="space-y-3">
            {workMessages.map((message) =>
              isReasoningMessage(message) ? (
                message.content.trim().length > 0 ? (
                  <div key={message.id}>
                    <CopilotChatAssistantMessage.MarkdownRenderer
                      content={message.content}
                    />
                  </div>
                ) : null
              ) : (
                <div key={message.id}>{renderActivityMessage(message)}</div>
              ),
            )}
          </div>
        ) : hasReasoningContent ? (
          <CopilotChatAssistantMessage.MarkdownRenderer content={content} />
        ) : null}
        {workMessages ? null : <CodexActivityList activities={activities} />}
        {isStreaming && hasReasoningContent ? (
          <span className="ml-1 inline-flex items-center align-middle">
            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CodexReasoningMessage({
  message,
  messages,
  isRunning,
  activities,
  workMessages,
}: {
  message: ReasoningMessage;
  messages: readonly Message[];
  isRunning?: boolean;
  activities: readonly ActivityMessage[];
  workMessages?: readonly WorkMessage[];
}) {
  const displayMessage =
    activities.length > 0 && message.content.length === 0
      ? { ...message, content: " " }
      : message;
  const contentView = useMemo(
    () =>
      function CodexReasoningContentSlot(
        props: Omit<
          Parameters<typeof CodexReasoningContent>[0],
          "activities" | "workMessages"
        >,
      ) {
        return (
          <CodexReasoningContent
            {...props}
            activities={activities}
            workMessages={workMessages}
          />
        );
      },
    [activities, workMessages],
  );

  return (
    <CopilotChatReasoningMessage
      message={displayMessage}
      messages={isRunning ? [...messages, displayMessage] : [...messages]}
      isRunning={isRunning}
      contentView={contentView}
    />
  );
}

function CodexTimelineLane({ children }: { children: React.ReactNode }) {
  return (
    <div className="cpk:mx-auto cpk:w-full cpk:max-w-3xl cpk:px-4">
      {children}
    </div>
  );
}

function CodexMessageView({
  messages = [],
  isRunning = false,
  hubrisIsRunning = false,
  ...props
}: CopilotChatMessageViewProps & { hubrisIsRunning?: boolean }) {
  const running = isRunning || hubrisIsRunning;

  return (
    <CopilotChatMessageView messages={messages} isRunning={running} {...props}>
      {({ messageElements, interruptElement }) => {
        const elementsByMessageId = new Map<string, ReactElement>();
        for (const element of messageElements) {
          if (typeof element.key === "string") {
            elementsByMessageId.set(element.key, element);
          }
        }

        const rendered: ReactElement[] = [];
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];

          if (isWorkMessage(message)) {
            const {
              message: workMessage,
              activities,
              workMessages,
              nextIndex,
            } = codexWorkBlock(messages, index);
            const isStreaming = running && nextIndex >= messages.length;
            const displayWorkMessage =
              isStreaming && workMessage.content.trim().length === 0
                ? { ...workMessage, content: "Thinking..." }
                : workMessage;
            if (
              displayWorkMessage.content.trim().length === 0 &&
              activities.length === 0
            ) {
              index = nextIndex - 1;
              continue;
            }
            rendered.push(
              <CodexTimelineLane key={displayWorkMessage.id}>
                <CodexReasoningMessage
                  message={displayWorkMessage}
                  messages={messages}
                  isRunning={isStreaming}
                  activities={activities}
                  workMessages={workMessages}
                />
              </CodexTimelineLane>,
            );
            index = nextIndex - 1;
            continue;
          }

          const element = elementForMessage(elementsByMessageId, message);
          if (element) {
            rendered.push(
              <CodexTimelineLane key={message.id}>{element}</CodexTimelineLane>,
            );
          }
        }

        const latestMessage = messages.at(-1);
        if (running && latestMessage?.role === "user") {
          const message = {
            id: `work-reasoning-pending-${latestMessage.id}`,
            role: "reasoning",
            content: "Thinking...",
          } as ReasoningMessage;
          rendered.push(
            <CodexTimelineLane key={message.id}>
              <CodexReasoningMessage
                message={message}
                messages={messages}
                isRunning
                activities={[]}
              />
            </CodexTimelineLane>,
          );
        }

        return (
          <div
            data-copilotkit
            data-testid="copilot-message-list"
            className="copilotKitMessages cpk:flex cpk:flex-col"
          >
            {rendered}
            {interruptElement}
          </div>
        );
      }}
    </CopilotChatMessageView>
  );
}

function CodexMessageViewWithState(props: CopilotChatMessageViewProps) {
  const hubrisIsRunning = useContext(HubrisRunningContext);
  return <CodexMessageView {...props} hubrisIsRunning={hubrisIsRunning} />;
}

const codexMessageViewSlot = Object.assign(CodexMessageViewWithState, {
  Cursor: CopilotChatMessageView.Cursor,
}) as typeof CopilotChatMessageView;

function ArchivedCopilotChatInput(_props: CopilotChatInputProps) {
  return (
    <div className="border-t bg-background/95 px-4 py-3 text-sm text-muted-foreground">
      <div className="mx-auto w-full max-w-3xl rounded-md border bg-muted/35 px-3 py-2">
        This chat is archived. Unarchive it from the Chats panel to continue.
      </div>
    </div>
  );
}

const archivedCopilotChatInputSlot = Object.assign(
  ArchivedCopilotChatInput,
  CopilotChatInput,
) as typeof CopilotChatInput;

function CopilotChatHeader({
  conversationId,
  label,
}: {
  conversationId: string;
  label: string;
}) {
  const copilotKitThemeMode = useChatSettings(
    (state) => state.settings.copilotkitThemeMode,
  );
  const updateChatSettings = useChatSettings((state) => state.updateSettings);
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);
  const { hasStreamingMessage, runtime } = useChatStore(
    useShallow((state) => selectChatHeaderSlice(state, conversationId)),
  );
  const running = isRuntimeRunning(runtime?.lifecycle) || hasStreamingMessage;

  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <MessageSquareText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{label}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {running ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            <span>CopilotKit AG-UI</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant={copilotKitThemeMode === "hubris" ? "secondary" : "ghost"}
          size="sm"
          disabled={writesBlocked}
          onClick={() => updateChatSettings({ copilotkitThemeMode: "hubris" })}
        >
          Hubris colors
        </Button>
        <Button
          type="button"
          variant={copilotKitThemeMode === "stock" ? "secondary" : "ghost"}
          size="sm"
          disabled={writesBlocked}
          onClick={() => updateChatSettings({ copilotkitThemeMode: "stock" })}
        >
          Stock
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={writesBlocked}
          onClick={() => updateChatSettings({ uiStyle: "classic" })}
        >
          Classic
        </Button>
      </div>
    </div>
  );
}

export default function CopilotKitAgentChatTabView({ tab, visible }: Props) {
  const conversationId = tab.conversationId;
  const rootRef = useRef<HTMLDivElement>(null);
  const detailState = useChatStore((state) =>
    selectChatDetailState(state, conversationId),
  );
  const conversation = useChatStore((state) =>
    selectChatConversation(state, conversationId),
  );
  const initialMessageVersion = useChatStore((state) =>
    initialMessagesSignature(state, conversationId),
  );
  const ensureConversationLoaded = useChatStore(
    (state) => state.ensureConversationLoaded,
  );
  const refreshConversation = useChatStore(
    (state) => state.refreshConversation,
  );
  const interruptRun = useChatStore((state) => state.interruptRun);
  const copilotKitThemeMode = useChatSettings(
    (state) => state.settings.copilotkitThemeMode,
  );
  const { hasStreamingMessage, runtime } = useChatStore(
    useShallow((state) => selectChatHeaderSlice(state, conversationId)),
  );
  const running = isRuntimeRunning(runtime?.lifecycle) || hasStreamingMessage;
  const isArchived = conversation?.archivedAt != null;

  useEffect(() => {
    if (!visible) {
      return;
    }
    void ensureConversationLoaded(conversationId);
  }, [conversationId, ensureConversationLoaded, visible]);

  useEffect(() => {
    if (!visible || !detailState.needsRefresh) {
      return;
    }
    void refreshConversation(conversationId);
  }, [conversationId, detailState.needsRefresh, refreshConversation, visible]);

  const initialMessages = useMemo(
    () => readInitialMessages(conversationId, initialMessageVersion),
    [conversationId, initialMessageVersion],
  );
  const agent = useMemo(
    () =>
      new HttpAgent({
        agentId: "codex",
        threadId: conversationId,
        url: codexAgUiChatUrl(conversationId),
        initialMessages,
        initialState: {
          conversationId,
          title: conversation?.title ?? tab.label,
        },
      }),
    [conversation?.title, conversationId, initialMessages, tab.label],
  );
  const agents = useMemo(() => ({ codex: agent }), [agent]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "Escape" && running) {
      event.preventDefault();
      void interruptRun(conversationId);
    }
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="agent-chat-tab"
      data-chat-ui-style="copilotkit"
      data-copilotkit-theme={copilotKitThemeMode}
      aria-label="Codex chat tab"
      onKeyDown={handleKeyDown}
    >
      <CopilotChatHeader conversationId={conversationId} label={tab.label} />
      {detailState.status === "loaded" ? (
        <HubrisRunningContext.Provider value={running}>
          <CopilotKitProvider
            selfManagedAgents={agents}
            renderActivityMessages={codexActivityRenderers}
          >
            <div className="min-h-0 flex-1 [&_.copilotKitChat]:h-full">
              <CopilotChat
                agentId="codex"
                className="h-full"
                input={isArchived ? archivedCopilotChatInputSlot : undefined}
                messageView={codexMessageViewSlot}
                labels={{
                  chatInputPlaceholder: "Ask Codex",
                  modalHeaderTitle: "Codex",
                  welcomeMessageText: "Ask Codex about this worktree.",
                }}
                onStop={() => void interruptRun(conversationId)}
              />
            </div>
          </CopilotKitProvider>
        </HubrisRunningContext.Provider>
      ) : detailState.status === "error" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          <div className="flex max-w-md items-start gap-3 rounded-md border bg-muted/35 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-3">
              <div>
                <div className="font-medium text-foreground">
                  Failed to load chat history
                </div>
                <div className="mt-1 break-words">
                  {detailState.error ?? "Unable to load this conversation."}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshConversation(conversationId)}
              >
                Retry
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading chat history...
        </div>
      )}
    </div>
  );
}
