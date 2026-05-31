import {
  CopilotChat,
  CopilotKitProvider,
  HttpAgent,
  type ReactActivityMessageRenderer,
  type Message,
} from "@copilotkit/react-core/v2";
import { LoaderCircle, MessageSquareText, Wrench } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { codexAgUiChatUrl } from "@/lib/api";
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
import { useChatUiStyle } from "@/lib/stores/chatUiStyle";
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
  const title = titleFromActivity(activityType, content);
  const summary = content.summary ?? content.content ?? null;
  const lines = detailLines(content);

  return (
    <div className="mx-auto my-1 w-full max-w-3xl px-4">
      <div className="rounded-md border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <Wrench className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{title}</span>
          {content.status ? (
            <span className="ml-auto shrink-0 text-[10px] uppercase">
              {content.status}
            </span>
          ) : null}
        </div>
        {summary ? (
          <div className="mt-1 line-clamp-2 break-words">{summary}</div>
        ) : null}
        {lines.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {lines.map((line) => (
              <span key={line} className="max-w-full truncate">
                {line}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isRuntimeRunning(lifecycle: string | undefined): boolean {
  return lifecycle === "starting" || lifecycle === "running";
}

function CopilotChatHeader({
  conversationId,
  label,
}: {
  conversationId: string;
  label: string;
}) {
  const setStyle = useChatUiStyle((state) => state.setStyle);
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setStyle("classic")}
      >
        Classic
      </Button>
    </div>
  );
}

export default function CopilotKitAgentChatTabView({ tab, visible }: Props) {
  const conversationId = tab.conversation_id;
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

  const initialMessages = useMemo(() => {
    void initialMessageVersion;
    return buildInitialMessages(useChatStore.getState(), conversationId);
  }, [conversationId, initialMessageVersion]);
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

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="agent-chat-tab"
      data-chat-ui-style="copilotkit"
      aria-label="Codex chat tab"
    >
      <CopilotChatHeader conversationId={conversationId} label={tab.label} />
      {detailState.status === "loaded" ? (
        <CopilotKitProvider
          selfManagedAgents={agents}
          renderActivityMessages={codexActivityRenderers}
        >
          <div className="min-h-0 flex-1 [&_.copilotKitChat]:h-full">
            <CopilotChat
              agentId="codex"
              className="h-full"
              labels={{
                chatInputPlaceholder: "Ask Codex",
                modalHeaderTitle: "Codex",
                welcomeMessageText: "Ask Codex about this worktree.",
              }}
              onStop={() => void interruptRun(conversationId)}
            />
          </div>
        </CopilotKitProvider>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading chat history...
        </div>
      )}
    </div>
  );
}
