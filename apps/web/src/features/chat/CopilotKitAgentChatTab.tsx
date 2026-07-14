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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { codexAgUiChatUrl } from "@/lib/api";
import { isRuntimeRunning } from "@/lib/chat/";
import { PendingRequestCard } from "@/features/chat/PendingRequestUi";
import { useChatSettings } from "@/lib/stores/chatSettings";
import {
  selectChatDiffSummary,
  selectChatActivePendingRequestIds,
  selectChatConversation,
  selectChatDetailState,
  selectChatHeaderSlice,
  selectChatItem,
  selectChatMessage,
  selectChatPendingRequest,
  selectChatPlan,
  selectChatReconciliation,
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
const HubrisSendBlockedReasonContext = createContext<string | null>(null);

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
  outputs?: CodexActivityOutput[];
};

type CodexActivityOutput = {
  id?: string;
  streamKind?: string;
  sequence?: number;
  content?: string;
  byteCount?: number;
  updatedAt?: number;
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

function activityOutputText(outputs: readonly CodexActivityOutput[]): string {
  let result = "";
  let previousStream: string | null = null;
  for (const chunk of outputs) {
    const content = stringValue(chunk.content);
    if (!content) {
      continue;
    }
    const stream = chunk.streamKind ?? "stdout";
    if (
      previousStream !== null &&
      stream !== previousStream &&
      !result.endsWith("\n")
    ) {
      result += "\n";
    }
    if (stream !== "stdout" && stream !== previousStream) {
      result += `[${stream}] `;
    }
    result += content;
    previousStream = stream;
  }
  return result;
}

function CodexActivityMessage({
  activityType,
  content,
}: {
  activityType: string;
  content: CodexActivityContent;
}) {
  const requestId = content.id;
  if (activityType.startsWith("codex.pending_request.") && requestId) {
    return <CodexPendingRequestActivity requestId={requestId} />;
  }

  return (
    <CodexWorkActivityMessage activityType={activityType} content={content} />
  );
}

function CodexPendingRequestActivity({ requestId }: { requestId: string }) {
  const request = useChatStore((state) =>
    selectChatPendingRequest(state, requestId),
  );
  if (!request) {
    return null;
  }

  return (
    <div data-chat-pending-request-panel="true">
      <PendingRequestCard request={request} compact />
    </div>
  );
}

function CodexWorkActivityMessage({
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
  const output = open ? activityOutputText(content.outputs ?? []) : "";

  return (
    <div
      role="group"
      aria-label={title}
      className="w-full rounded-md border bg-muted/30 text-xs text-muted-foreground"
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {title}
        </span>
        {content.status ? (
          <span
            className="shrink-0 text-[10px] uppercase"
            role={content.status === "streaming" ? "status" : undefined}
            aria-label={`${title} status: ${content.status}`}
          >
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
          {output ? (
            <pre
              className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 text-xs text-foreground"
              aria-label={`${title} output`}
            >
              {output}
            </pre>
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

const SETTLED_TIMELINE_STYLE: CSSProperties = {
  contain: "layout paint style",
  contentVisibility: "auto",
  containIntrinsicSize: "auto 8rem",
};

function isNearChatBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
}

function scrollChatToBottom(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

function findChatScrollContainer(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement;
  while (candidate) {
    const overflowY =
      candidate.ownerDocument.defaultView?.getComputedStyle(candidate)
        .overflowY ?? "";
    if (
      candidate.scrollHeight > candidate.clientHeight ||
      overflowY === "auto" ||
      overflowY === "scroll"
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function CodexTimelineLane({
  children,
  live = false,
  variant = "prose",
}: {
  children: React.ReactNode;
  live?: boolean;
  variant?: "prose" | "work" | "request";
}) {
  const variantClass = {
    prose: "cpk:py-2",
    work: "cpk:my-1 cpk:border-l cpk:border-border/60 cpk:py-1 cpk:pl-4",
    request:
      "cpk:my-2 cpk:rounded-lg cpk:border-l-2 cpk:border-primary/60 cpk:bg-muted/20 cpk:py-1 cpk:pl-4",
  }[variant];

  return (
    <div
      aria-busy={live || undefined}
      data-chat-row-kind={variant}
      data-chat-row-state={live ? "live" : "settled"}
      className={`cpk:mx-auto cpk:w-full cpk:max-w-3xl cpk:px-4 ${variantClass}`}
      style={live ? undefined : SETTLED_TIMELINE_STYLE}
    >
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
  const messageListRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const followBottomRef = useRef(true);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) {
      return;
    }
    const scrollContainer = findChatScrollContainer(messageList);
    if (!scrollContainer) {
      return;
    }
    scrollContainerRef.current = scrollContainer;
    const updateFollowState = () => {
      followBottomRef.current = isNearChatBottom(scrollContainer);
    };
    scrollContainer.addEventListener("scroll", updateFollowState, {
      passive: true,
    });
    return () => {
      scrollContainer.removeEventListener("scroll", updateFollowState);
      scrollContainerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const scrollContainer =
      scrollContainerRef.current ??
      (messageListRef.current
        ? findChatScrollContainer(messageListRef.current)
        : null);
    if (scrollContainer && followBottomRef.current) {
      scrollChatToBottom(scrollContainer);
    }
  }, [messages, running]);

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
            const hasPendingRequest = activities.some((activity) =>
              activity.activityType.startsWith("codex.pending_request."),
            );
            const hasActivePendingRequest = activities.some((activity) => {
              if (!activity.activityType.startsWith("codex.pending_request.")) {
                return false;
              }
              const status = normalizeActivityContent(activity.content).status;
              return status === "pending" || status === "resolving";
            });
            const displayWorkMessage =
              isStreaming && workMessage.content.trim().length === 0
                ? { ...workMessage, content: "Thinking…" }
                : workMessage;
            if (
              displayWorkMessage.content.trim().length === 0 &&
              activities.length === 0
            ) {
              index = nextIndex - 1;
              continue;
            }
            rendered.push(
              <CodexTimelineLane
                key={displayWorkMessage.id}
                live={isStreaming || hasActivePendingRequest}
                variant={hasPendingRequest ? "request" : "work"}
              >
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
            const isLiveAssistant =
              running &&
              index === messages.length - 1 &&
              message.role === "assistant";
            rendered.push(
              <CodexTimelineLane key={message.id} live={isLiveAssistant}>
                {element}
              </CodexTimelineLane>,
            );
          }
        }

        const latestMessage = messages.at(-1);
        if (running && latestMessage?.role === "user") {
          const message = {
            id: `work-reasoning-pending-${latestMessage.id}`,
            role: "reasoning",
            content: "Thinking…",
          } as ReasoningMessage;
          rendered.push(
            <CodexTimelineLane key={message.id} live variant="work">
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
            ref={messageListRef}
            data-copilotkit
            data-testid="copilot-message-list"
            className="copilotKitMessages cpk:flex cpk:flex-col cpk:gap-1 cpk:pb-6"
            role="log"
            aria-label="Codex conversation"
            aria-relevant="additions"
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

function HubrisCopilotChatSendButton(
  props: ComponentProps<typeof CopilotChatInput.SendButton>,
) {
  const sendBlockedReason = useContext(HubrisSendBlockedReasonContext);
  const hubrisIsRunning = useContext(HubrisRunningContext);
  const label = hubrisIsRunning ? "Interrupt run" : "Send message";

  return (
    <CopilotChatInput.SendButton
      {...props}
      aria-label={label}
      title={sendBlockedReason ?? label}
    />
  );
}

function HubrisCopilotChatInput(props: CopilotChatInputProps) {
  const hubrisIsRunning = useContext(HubrisRunningContext);
  const sendBlockedReason = useContext(HubrisSendBlockedReasonContext);
  const isRunning = hubrisIsRunning || props.isRunning === true;

  return (
    <div className="flex flex-col">
      <CopilotChatInput
        {...props}
        isRunning={isRunning}
        sendButton={props.sendButton ?? HubrisCopilotChatSendButton}
        onSubmitMessage={
          isRunning || sendBlockedReason ? undefined : props.onSubmitMessage
        }
      />
      {sendBlockedReason ? (
        <div
          role="status"
          className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-muted-foreground"
        >
          {sendBlockedReason}
        </div>
      ) : null}
    </div>
  );
}

const hubrisCopilotChatInputSlot = Object.assign(
  HubrisCopilotChatInput,
  CopilotChatInput,
) as typeof CopilotChatInput;

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
        <MessageSquareText
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{label}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {running ? (
              <span role="status" aria-label="Codex is running">
                <LoaderCircle
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              </span>
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
          aria-pressed={copilotKitThemeMode === "hubris"}
          onClick={() => updateChatSettings({ copilotkitThemeMode: "hubris" })}
        >
          Hubris colors
        </Button>
        <Button
          type="button"
          variant={copilotKitThemeMode === "stock" ? "secondary" : "ghost"}
          size="sm"
          disabled={writesBlocked}
          aria-pressed={copilotKitThemeMode === "stock"}
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

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'button, input, textarea, select, [contenteditable="true"], [role="textbox"], [data-chat-ignore-shortcuts="true"]',
      ),
    )
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
  const reconciliation = useChatStore((state) =>
    selectChatReconciliation(state, conversationId),
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
  const { hasBlockingRequest, hasStreamingMessage, runtime } = useChatStore(
    useShallow((state) => ({
      ...selectChatHeaderSlice(state, conversationId),
      hasBlockingRequest:
        selectChatActivePendingRequestIds(state, conversationId).length > 0,
    })),
  );
  const running = isRuntimeRunning(runtime?.lifecycle) || hasStreamingMessage;
  const isArchived = conversation?.archivedAt != null;
  const sendBlockedReason = hasBlockingRequest
    ? "Sending is paused until the pending request is answered."
    : reconciliation?.status === "running"
      ? "Sending is paused while Hubris reconciles Codex thread state."
      : null;

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
    if (event.key === "/" && !isInteractiveShortcutTarget(event.target)) {
      event.preventDefault();
      rootRef.current
        ?.querySelector<HTMLElement>(
          'textarea:not([disabled]), [role="textbox"]:not([aria-disabled="true"])',
        )
        ?.focus();
      return;
    }
    if (event.key === "Escape" && running) {
      event.preventDefault();
      void interruptRun(conversationId);
      return;
    }
    if (event.altKey && event.code === "KeyA" && hasBlockingRequest) {
      event.preventDefault();
      rootRef.current
        ?.querySelector<HTMLElement>(
          '[data-chat-pending-request-panel="true"] [data-chat-pending-action="primary"]',
        )
        ?.focus();
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
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <CopilotChatHeader conversationId={conversationId} label={tab.label} />
      {detailState.status === "loaded" ? (
        <HubrisRunningContext.Provider value={running}>
          <HubrisSendBlockedReasonContext.Provider value={sendBlockedReason}>
            <CopilotKitProvider
              selfManagedAgents={agents}
              renderActivityMessages={codexActivityRenderers}
            >
              <div className="min-h-0 flex-1 [&_.copilotKitChat]:h-full">
                <CopilotChat
                  agentId="codex"
                  autoScroll="none"
                  className="h-full"
                  input={
                    isArchived
                      ? archivedCopilotChatInputSlot
                      : hubrisCopilotChatInputSlot
                  }
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
          </HubrisSendBlockedReasonContext.Provider>
        </HubrisRunningContext.Provider>
      ) : detailState.status === "error" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          <div className="flex max-w-md items-start gap-3 rounded-md border bg-muted/35 p-4">
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
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
          Loading chat history…
        </div>
      )}
    </div>
  );
}
