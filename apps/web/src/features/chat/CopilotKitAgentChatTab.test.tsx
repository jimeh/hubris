// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentType, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CopilotKitAgentChatTabView from "@/features/chat/CopilotKitAgentChatTab";
import { makeLongChatDetail } from "@/features/chat/CopilotKitAgentChatTab.fixtures";
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
  interruptChat: vi.fn(),
  resolveChatPendingRequest: vi.fn(),
}));

const copilotKitMock = vi.hoisted(() => ({
  activityRenderer: null as ComponentType<{
    activityType: string;
    content: Record<string, unknown>;
  }> | null,
  latestAgent: null as null | {
    initialMessages: MockAgentMessage[];
  },
  submitMessage: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getChat: (...args: unknown[]) => apiMocks.getChat(...args),
    interruptChat: (...args: unknown[]) => apiMocks.interruptChat(...args),
    resolveChatPendingRequest: (...args: unknown[]) =>
      apiMocks.resolveChatPendingRequest(...args),
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

  const DefaultSendButton = (
    props: React.ButtonHTMLAttributes<HTMLButtonElement>,
  ) => <button type="button" {...props} />;

  function CopilotChatInput({
    isRunning = false,
    onStop,
    onSubmitMessage,
    sendButton: SendButton = DefaultSendButton,
  }: {
    isRunning?: boolean;
    onStop?: () => void;
    onSubmitMessage?: (value: string) => void;
    sendButton?: ComponentType<React.ButtonHTMLAttributes<HTMLButtonElement>>;
  }) {
    const [value, setValue] = useState("");
    const send = () => {
      const trimmed = value.trim();
      if (!trimmed || !onSubmitMessage) {
        return;
      }
      onSubmitMessage(trimmed);
      setValue("");
    };

    return (
      <div>
        <textarea
          aria-label="Ask Codex"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) {
              return;
            }
            event.preventDefault();
            if (isRunning && !onSubmitMessage) {
              onStop?.();
              return;
            }
            send();
          }}
        />
        <SendButton
          disabled={isRunning ? !onStop : !onSubmitMessage || !value.trim()}
          onClick={() => {
            if (isRunning) {
              onStop?.();
              return;
            }
            send();
          }}
        >
          {isRunning ? <span>stop</span> : undefined}
        </SendButton>
      </div>
    );
  }

  return {
    CopilotChat: ({
      input: Input,
      messageView: MessageView,
      onStop,
    }: {
      input?: ComponentType<{
        onStop?: () => void;
        onSubmitMessage?: (value: string) => void;
      }>;
      messageView: ComponentType<{
        messages?: unknown[];
        isRunning?: boolean;
      }>;
      onStop?: () => void;
    }) => (
      <div data-testid="copilot-chat">
        <div data-testid="copilot-scroll" style={{ overflowY: "auto" }}>
          <MessageView
            messages={copilotKitMock.latestAgent?.initialMessages ?? []}
            isRunning={false}
          />
        </div>
        {Input ? (
          <Input
            onStop={onStop}
            onSubmitMessage={(value) => copilotKitMock.submitMessage(value)}
          />
        ) : (
          <textarea aria-label="Ask Codex" />
        )}
      </div>
    ),
    CopilotChatAssistantMessage,
    CopilotChatInput: Object.assign(CopilotChatInput, {
      SendButton: DefaultSendButton,
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
    worktreeId: "worktree-1",
    paneId: "pane-1",
    sessionId: "default",
    createdAt: 10,
    preview: false,
    conversationId: "chat-1",
  };
}

function makeDetail({
  archived = false,
  pending = false,
  reconciling = false,
}: {
  archived?: boolean;
  pending?: boolean;
  reconciling?: boolean;
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
      lastReconciliationState: reconciling ? "running" : "not_needed",
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
    latestReconciliation: reconciling
      ? {
          id: "reconciliation-1",
          conversationId: "chat-1",
          providerThreadId: "thread-1",
          status: "running",
          reason: "recovering Codex thread state",
          startedAt: 18,
          finishedAt: null,
          errorMessage: null,
          ownerGeneration: 1,
          createdAt: 18,
          updatedAt: 18,
        }
      : null,
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

function updateFirstMessage(contentText: string) {
  act(() => {
    useChatStore.setState((state) => ({
      messagesById: {
        ...state.messagesById,
        "message-user-1": {
          ...state.messagesById["message-user-1"]!,
          contentText,
          updatedAt: 30,
        },
      },
    }));
  });
}

function mockScrollMetrics(
  element: HTMLElement,
  initialScrollTop: number,
): {
  writes: number[];
  setScrollTop: (value: number) => void;
} {
  let scrollTop = initialScrollTop;
  const writes: number[] = [];
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        writes.push(value);
      },
    },
  });
  return {
    writes,
    setScrollTop(value) {
      scrollTop = value;
    },
  };
}

describe("CopilotKitAgentChatTab", () => {
  beforeEach(() => {
    resetChatStoreForTests();
    resetSettingsStoreForTests();
    resetTabStoreForTests();
    apiMocks.getChat.mockReset();
    apiMocks.interruptChat.mockReset().mockResolvedValue(undefined);
    apiMocks.resolveChatPendingRequest.mockReset().mockResolvedValue(undefined);
    copilotKitMock.submitMessage.mockReset();
    copilotKitMock.activityRenderer = null;
    copilotKitMock.latestAgent = null;
  });

  it("rebuilds the agent when loaded messages change", async () => {
    await renderChat();

    expect(screen.getByTestId("agent-chat-tab")).toBeVisible();
    expect(screen.getByTestId("copilot-message-list")).toBeVisible();

    const previousAgent = copilotKitMock.latestAgent;
    const updatedText = "Please inspect the updated repository";

    updateFirstMessage(updatedText);

    expect(copilotKitMock.latestAgent).not.toBe(previousAgent);
    expect(copilotKitMock.latestAgent?.initialMessages).toContainEqual({
      id: "message-user-1",
      role: "user",
      content: updatedText,
    });
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
    expect(screen.getByText("Thinking…")).toBeVisible();
  });

  it("renders a pending request activity", async () => {
    await renderChat(makeDetail({ pending: true }));

    expect(
      screen.getByRole("group", { name: "Command approval" }),
    ).toBeVisible();
    expect(screen.getByText("Waiting for response")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    const requestRow = screen
      .getByRole("group", { name: "Command approval" })
      .closest('[data-chat-row-state="live"]');
    expect(requestRow).not.toBeNull();

    act(() => {
      useChatStore.setState((state) => ({
        pendingRequestsById: {
          ...state.pendingRequestsById,
          "request-1": {
            ...state.pendingRequestsById["request-1"]!,
            status: "resolved",
            decision: "accept",
            resolvedAt: 30,
            updatedAt: 30,
          },
        },
      }));
    });
    expect(screen.getByText("Resolved")).toBeVisible();
    expect(
      screen
        .getByRole("group", { name: "Command approval" })
        .closest('[data-chat-row-state="settled"]'),
    ).not.toBeNull();
  });

  it("keeps a request lane live when a terminal request precedes an active one", async () => {
    const detail = makeDetail({ pending: true });
    const pending = detail.pendingRequests[0]!;
    detail.pendingRequests = [
      {
        ...pending,
        id: "request-resolved",
        providerRequestId: "provider-request-resolved",
        status: "resolved",
        decision: "accept",
        sequence: 2,
        responseJson: JSON.stringify({ decision: "accept" }),
        resolvedAt: 13,
      },
      {
        ...pending,
        id: "request-active",
        providerRequestId: "provider-request-active",
        sequence: 3,
      },
    ];
    detail.conversation.latestPendingRequestId = "request-active";

    await renderChat(detail);

    expect(screen.getByText("Resolved")).toBeVisible();
    expect(screen.getByText("Waiting for response")).toBeVisible();
    expect(
      screen
        .getByText("Waiting for response")
        .closest('[data-chat-row-state="live"]'),
    ).not.toBeNull();
  });

  it("renders live activity output with explicit stream boundaries", async () => {
    await renderChat();
    const Renderer = copilotKitMock.activityRenderer!;
    render(
      <Renderer
        activityType="codex.command_execution"
        content={{
          id: "command-1",
          kind: "command_execution",
          status: "streaming",
          title: "Command",
          outputs: [
            { id: "one", streamKind: "stdout", content: "first" },
            { id: "two", streamKind: "stdout", content: " second" },
            { id: "three", streamKind: "stderr", content: "warning" },
            { id: "four", streamKind: "stderr", content: " continued" },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Command/ }));
    expect(screen.getByLabelText("Command output")).toHaveTextContent(
      "first second [stderr] warning continued",
    );
  });

  it("defers combining long activity output until the row is expanded", async () => {
    await renderChat();
    const Renderer = copilotKitMock.activityRenderer!;
    let contentReads = 0;
    const outputs = Array.from({ length: 400 }, (_, index) => ({
      id: `output-${index}`,
      streamKind: "stdout",
      get content() {
        contentReads += 1;
        return `${index} `;
      },
    }));
    render(
      <Renderer
        activityType="codex.command_execution"
        content={{
          id: "command-long",
          kind: "command_execution",
          status: "completed",
          title: "Long command",
          outputs,
        }}
      />,
    );

    expect(contentReads).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /Long command/ }));
    expect(contentReads).toBe(400);
    expect(screen.getByLabelText("Long command output")).toHaveTextContent(
      "0 1 2 3",
    );
  });

  it("keeps settled rows contained while leaving the active tail live", async () => {
    apiMocks.getChat.mockResolvedValue(makeLongChatDetail());
    render(<CopilotKitAgentChatTabView tab={makeTab()} visible />);
    await screen.findByText("Assistant response 249");

    const messageList = screen.getByTestId("copilot-message-list");
    const settledRows = messageList.querySelectorAll(
      '[data-chat-row-state="settled"]',
    );
    expect(settledRows.length).toBeGreaterThan(250);
    expect(settledRows[0]).toHaveStyle({
      contain: "layout paint style",
      contentVisibility: "auto",
    });
    expect(
      messageList.querySelector('[data-chat-row-state="live"]'),
    ).toBeNull();
    expect(
      messageList.querySelectorAll('[data-chat-pending-request-panel="true"]'),
    ).toHaveLength(25);
    expect(messageList.querySelectorAll("section")).toHaveLength(0);
    const firstSettledRow = settledRows[0];

    act(() => {
      useChatStore.setState({
        runtimesByConversationId: { "chat-1": runningRuntime() },
      });
    });

    const liveRows = messageList.querySelectorAll(
      '[data-chat-row-state="live"]',
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).not.toHaveStyle({ contentVisibility: "auto" });
    expect(messageList.querySelector('[data-chat-row-state="settled"]')).toBe(
      firstSettledRow,
    );
  });

  it("uses the long fixture to leave one streaming final response live", async () => {
    apiMocks.getChat.mockResolvedValue(
      makeLongChatDetail({ liveFinalTurn: true }),
    );
    render(<CopilotKitAgentChatTabView tab={makeTab()} visible />);
    await screen.findByText("Assistant response 249");

    const messageList = screen.getByTestId("copilot-message-list");
    const liveRows = messageList.querySelectorAll(
      '[data-chat-row-state="live"]',
    );
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).toHaveTextContent("Assistant response 249");
    expect(messageList).toHaveTextContent(
      "Checked repository state for turn 240",
    );
    expect(
      messageList.querySelectorAll('[data-chat-pending-request-panel="true"]'),
    ).toHaveLength(25);
  });

  it("follows new output only while the reader remains near the bottom", async () => {
    await renderChat();
    const scroll = screen.getByTestId("copilot-scroll");
    const metrics = mockScrollMetrics(scroll, 570);

    fireEvent.scroll(scroll);
    metrics.writes.length = 0;
    updateFirstMessage("Near-bottom update");
    expect(metrics.writes).toEqual([600]);

    metrics.setScrollTop(100);
    fireEvent.scroll(scroll);
    metrics.writes.length = 0;
    updateFirstMessage("Scrolled-up update");
    expect(metrics.writes).toEqual([]);

    metrics.setScrollTop(560);
    fireEvent.scroll(scroll);
    updateFirstMessage("Following again");
    expect(metrics.writes).toEqual([600]);
  });

  it("supports composer, cancel, and pending-request keyboard paths", async () => {
    const user = userEvent.setup();
    await renderChat(makeDetail({ pending: true }));
    const root = screen.getByTestId("agent-chat-tab");
    const composer = screen.getByRole("textbox", { name: "Ask Codex" });

    fireEvent.keyDown(root, { key: "/" });
    expect(composer).toHaveFocus();

    act(() => {
      useChatStore.setState({
        runtimesByConversationId: { "chat-1": runningRuntime() },
      });
    });
    expect(composer).toHaveFocus();

    fireEvent.keyDown(root, { key: "Escape" });
    await waitFor(() => expect(apiMocks.interruptChat).toHaveBeenCalledOnce());

    fireEvent.keyDown(root, { key: "ф", code: "KeyA", altKey: true });
    const allow = screen.getByRole("button", { name: "Allow" });
    expect(allow).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(apiMocks.resolveChatPendingRequest).toHaveBeenCalledWith(
        "chat-1",
        "request-1",
        { decision: "accept" },
      ),
    );
  });

  it("keeps the draft while the active-run stop control interrupts", async () => {
    const user = userEvent.setup();
    await renderChat();
    const composer = screen.getByRole("textbox", { name: "Ask Codex" });
    await user.type(composer, "Keep this draft");

    act(() => {
      useChatStore.setState({
        runtimesByConversationId: { "chat-1": runningRuntime() },
      });
    });

    await user.keyboard("{Enter}");
    await waitFor(() => expect(apiMocks.interruptChat).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("Keep this draft");
    expect(copilotKitMock.submitMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Interrupt run" }));
    await waitFor(() =>
      expect(apiMocks.interruptChat).toHaveBeenCalledTimes(2),
    );
    expect(composer).toHaveValue("Keep this draft");
    expect(copilotKitMock.submitMessage).not.toHaveBeenCalled();
  });

  it("keeps pending-request drafts while submission is blocked", async () => {
    const user = userEvent.setup();
    await renderChat(makeDetail({ pending: true }));
    const composer = screen.getByRole("textbox", { name: "Ask Codex" });
    await user.type(composer, "Send after approval");

    expect(
      screen.getByText(
        "Sending is paused until the pending request is answered.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(copilotKitMock.submitMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue("Send after approval");
  });

  it("keeps reconciliation drafts while submission is blocked", async () => {
    const user = userEvent.setup();
    await renderChat(makeDetail({ reconciling: true }));
    const composer = screen.getByRole("textbox", { name: "Ask Codex" });
    await user.type(composer, "Send after reconciliation");

    expect(
      screen.getByText(
        "Sending is paused while Hubris reconciles Codex thread state.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(copilotKitMock.submitMessage).not.toHaveBeenCalled();
    expect(composer).toHaveValue("Send after reconciliation");
  });

  it("keeps normal CopilotKit submission wired", async () => {
    const user = userEvent.setup();
    await renderChat();
    const composer = screen.getByRole("textbox", { name: "Ask Codex" });
    await user.type(composer, "Inspect the change");

    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(copilotKitMock.submitMessage).toHaveBeenCalledWith(
      "Inspect the change",
    );
    expect(composer).toHaveValue("");
  });

  it("exposes conversation, status, and theme-control semantics", async () => {
    await renderChat();

    expect(
      screen.getByRole("log", { name: "Codex conversation" }),
    ).toHaveAttribute("aria-relevant", "additions");
    expect(
      screen.getByRole("log", { name: "Codex conversation" }),
    ).not.toHaveAttribute("aria-live");
    expect(
      screen.getByRole("button", { name: "Hubris colors" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Stock" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    act(() => {
      useChatStore.setState({
        runtimesByConversationId: { "chat-1": runningRuntime() },
      });
    });
    expect(
      screen.getByRole("status", { name: "Codex is running" }),
    ).toBeVisible();
  });

  it("renders archived conversations as read-only", async () => {
    await renderChat(makeDetail({ archived: true }));

    expect(
      screen.getByText(/This chat is archived\. Unarchive it/),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Ask Codex" })).toBeNull();
  });
});
