// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CopilotKitAgentChatTabView from "@/components/CopilotKitAgentChatTab";
import { resetChatStoreForTests, useChatStore } from "@/lib/stores/chats";
import { resetSettingsStoreForTests } from "@/lib/stores/settings";
import { resetTabStoreForTests } from "@/lib/stores/tabs";
import type {
  AgentChatTab,
  ChatConversationDetail,
  ChatRuntimeStatus,
} from "@/lib/types";

type MockAgentMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
};

const apiMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
}));

const copilotKitMock = vi.hoisted(() => ({
  activityRenderer: null as ComponentType<{
    activityType: string;
    content: Record<string, unknown>;
  }> | null,
  latestAgent: null as null | {
    initialMessages: MockAgentMessage[];
  },
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getChat: (...args: unknown[]) => apiMocks.getChat(...args),
  };
});

vi.mock("@copilotkit/react-core/v2", () => {
  function CopilotChatMessageView({
    children,
    messages = [],
  }: {
    children: (props: {
      messageElements: React.ReactElement[];
      interruptElement: React.ReactElement | null;
    }) => ReactNode;
    messages?: Array<{ id: string; content?: unknown }>;
  }) {
    return children({
      messageElements: messages.map((message) => (
        <div key={message.id}>{String(message.content ?? "")}</div>
      )),
      interruptElement: null,
    });
  }
  CopilotChatMessageView.Cursor = () => <span>cursor</span>;

  const CopilotChatAssistantMessage = Object.assign(
    ({ message }: { message: { content?: unknown } }) => (
      <div>{String(message.content ?? "")}</div>
    ),
    {
      MarkdownRenderer: ({ content }: { content: string }) => (
        <div>{content}</div>
      ),
    },
  );

  return {
    CopilotChat: ({
      input: Input,
      messageView: MessageView,
    }: {
      input?: ComponentType;
      messageView: ComponentType<{
        messages?: unknown[];
        isRunning?: boolean;
      }>;
    }) => (
      <div data-testid="copilot-chat">
        <MessageView
          messages={copilotKitMock.latestAgent?.initialMessages ?? []}
          isRunning={false}
        />
        {Input ? <Input /> : <textarea aria-label="Ask Codex" />}
      </div>
    ),
    CopilotChatAssistantMessage,
    CopilotChatInput: Object.assign(() => null, {
      SendButton: () => null,
      ToolbarButton: () => null,
      StartTranscribeButton: () => null,
      CancelTranscribeButton: () => null,
      FinishTranscribeButton: () => null,
      AddMenuButton: () => null,
      TextArea: () => null,
      AudioRecorder: () => null,
      Disclaimer: () => null,
    }),
    CopilotChatMessageView,
    CopilotChatReasoningMessage: ({
      contentView: ContentView,
      isRunning,
      message,
    }: {
      contentView: ComponentType<{
        children: string;
        hasContent: boolean;
        isStreaming?: boolean;
      }>;
      isRunning?: boolean;
      message: { content: string };
    }) => (
      <ContentView
        hasContent={message.content.trim().length > 0}
        isStreaming={isRunning}
      >
        {message.content}
      </ContentView>
    ),
    CopilotKitProvider: ({
      children,
      renderActivityMessages,
    }: {
      children: ReactNode;
      renderActivityMessages: Array<{
        render: typeof copilotKitMock.activityRenderer;
      }>;
    }) => {
      copilotKitMock.activityRenderer =
        renderActivityMessages[0]?.render ?? null;
      return children;
    },
    HttpAgent: class HttpAgent {
      initialMessages: MockAgentMessage[];

      constructor(options: { initialMessages: MockAgentMessage[] }) {
        this.initialMessages = options.initialMessages;
        copilotKitMock.latestAgent = this;
      }
    },
    useRenderActivityMessage: () => ({
      renderActivityMessage: (message: {
        activityType: string;
        content: Record<string, unknown>;
      }) => {
        const Renderer = copilotKitMock.activityRenderer;
        return Renderer ? (
          <Renderer
            activityType={message.activityType}
            content={message.content}
          />
        ) : null;
      },
    }),
  };
});

function makeTab(): AgentChatTab {
  return {
    id: "tab-chat-1",
    type: "agent_chat",
    label: "Codex Chat",
    position: 1,
    worktree_id: "worktree-1",
    pane_id: "pane-1",
    session_id: "default",
    created_at: 10,
    preview: false,
    conversation_id: "chat-1",
  };
}

function makeDetail({
  archived = false,
  pending = false,
}: {
  archived?: boolean;
  pending?: boolean;
} = {}): ChatConversationDetail {
  return {
    conversation: {
      id: "chat-1",
      sessionId: "default",
      projectId: "project-1",
      worktreeId: "worktree-1",
      provider: "codex",
      providerThreadId: "thread-1",
      title: "Codex Chat",
      createdAt: 10,
      updatedAt: 20,
      lastActivityAt: 20,
      lastMessageAt: 20,
      openTabId: "tab-chat-1",
      archivedAt: archived ? 20 : null,
      selectedModel: null,
      selectedEffort: null,
      selectedPermissionMode: null,
      lastRunState: "completed",
      lastError: null,
      lastReconciliationState: "not_needed",
      lastReconciliationError: null,
      pendingRequestCount: pending ? 1 : 0,
      latestPendingRequestId: pending ? "request-1" : null,
      latestPendingRequestKind: pending ? "command_approval" : null,
      latestPendingRequestStatus: pending ? "pending" : null,
      hasPendingRequestAttention: pending,
      contextUsedTokens: null,
      contextMaxTokens: null,
      contextPercentUsed: null,
      contextUpdatedAt: null,
      revision: 1,
    },
    messages: [
      {
        id: "message-user-1",
        conversationId: "chat-1",
        turnId: null,
        itemId: null,
        providerTurnId: null,
        providerItemId: null,
        role: "user",
        status: "completed",
        contentText: "Please inspect the repository",
        reasoningText: "",
        sequence: 1,
        createdAt: 10,
        updatedAt: 10,
      },
    ],
    turns: [],
    items: [],
    plans: [],
    diffSummaries: [],
    contextUsage: null,
    pendingRequests: pending
      ? [
          {
            id: "request-1",
            conversationId: "chat-1",
            turnId: null,
            itemId: null,
            providerRequestId: "provider-request-1",
            providerTurnId: null,
            providerItemId: null,
            method: "item/commandExecution/requestApproval",
            kind: "command_approval",
            status: "pending",
            decision: null,
            ownerGeneration: 1,
            sequence: 2,
            payloadJson: JSON.stringify({ command: "mise run check" }),
            responseJson: null,
            errorMessage: null,
            createdAt: 12,
            updatedAt: 12,
            resolvedAt: null,
          },
        ]
      : [],
    latestReconciliation: null,
    latestRun: null,
  };
}

function runningRuntime(): ChatRuntimeStatus {
  return {
    conversationId: "chat-1",
    sessionId: "default",
    projectId: "project-1",
    worktreeId: "worktree-1",
    lifecycle: "running",
    activeRunId: "run-1",
    activeMessageId: null,
    providerThreadId: "thread-1",
    lastError: null,
    updatedAt: 30,
  };
}

async function renderChat(detail = makeDetail()) {
  apiMocks.getChat.mockResolvedValue(detail);
  render(<CopilotKitAgentChatTabView tab={makeTab()} visible />);
  await screen.findByText("Please inspect the repository");
}

describe("CopilotKitAgentChatTab", () => {
  beforeEach(() => {
    resetChatStoreForTests();
    resetSettingsStoreForTests();
    resetTabStoreForTests();
    apiMocks.getChat.mockReset();
    copilotKitMock.activityRenderer = null;
    copilotKitMock.latestAgent = null;
  });

  it("renders a loaded conversation", async () => {
    await renderChat();

    expect(screen.getByTestId("agent-chat-tab")).toBeVisible();
    expect(screen.getByTestId("copilot-message-list")).toBeVisible();
  });

  it("preserves the message-view DOM node across running-state changes", async () => {
    await renderChat();
    const messageList = screen.getByTestId("copilot-message-list");

    act(() => {
      useChatStore.setState({
        runtimesByConversationId: { "chat-1": runningRuntime() },
      });
    });

    expect(screen.getByTestId("copilot-message-list")).toBe(messageList);
    expect(screen.getByText("Thinking...")).toBeVisible();
  });

  it("renders a pending request activity", async () => {
    await renderChat(makeDetail({ pending: true }));

    expect(screen.getByText("Codex request")).toBeVisible();
    expect(screen.getByText("pending")).toBeVisible();
  });

  it("renders archived conversations as read-only", async () => {
    await renderChat(makeDetail({ archived: true }));

    expect(
      screen.getByText(/This chat is archived\. Unarchive it/),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Ask Codex" })).toBeNull();
  });
});
