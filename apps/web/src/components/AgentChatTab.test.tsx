// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import AgentChatTabView from "@/components/AgentChatTab";
import {
  resetChatStoreForTests,
  selectChatTimelineIds,
  useChatStore,
} from "@/lib/stores/chats";
import { resetTabStoreForTests } from "@/lib/stores/tabs";
import type {
  AgentChatTab,
  ChatConversationDetail,
  ChatMessage,
} from "@/lib/types";

const apiMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  getChatActivity: vi.fn(),
  interruptChat: vi.fn(),
  listChatModels: vi.fn(),
  patchChatSettings: vi.fn(),
  sendChatMessage: vi.fn(),
}));

const assistantRuntime = vi.hoisted(() => ({
  composerValue: "",
  current: null as null | {
    onCancel?: () => Promise<void>;
    onNew?: (message: {
      content: Array<{ type: "text"; text: string }>;
    }) => Promise<void>;
  },
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getChat: (...args: unknown[]) => apiMocks.getChat(...args),
    getChatActivity: (...args: unknown[]) => apiMocks.getChatActivity(...args),
    interruptChat: (...args: unknown[]) => apiMocks.interruptChat(...args),
    listChatModels: (...args: unknown[]) => apiMocks.listChatModels(...args),
    patchChatSettings: (...args: unknown[]) =>
      apiMocks.patchChatSettings(...args),
    sendChatMessage: (...args: unknown[]) => apiMocks.sendChatMessage(...args),
  };
});

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ComposerPrimitive: {
    Cancel: ({ children, ...props }: ComponentProps<"button">) => (
      <button
        type="button"
        {...props}
        onClick={() => void assistantRuntime.current?.onCancel?.()}
      >
        {children}
      </button>
    ),
    Input: ({
      submitMode: _submitMode,
      ...props
    }: ComponentProps<"textarea"> & { submitMode?: string }) => (
      <textarea
        {...props}
        onChange={(event) => {
          assistantRuntime.composerValue = event.currentTarget.value;
          props.onChange?.(event);
        }}
      />
    ),
    Root: ({ children, ...props }: ComponentProps<"div">) => (
      <div {...props}>{children}</div>
    ),
    Send: ({ children, ...props }: ComponentProps<"button">) => (
      <button
        type="button"
        {...props}
        onClick={() =>
          void assistantRuntime.current?.onNew?.({
            content: [
              {
                type: "text",
                text: assistantRuntime.composerValue || "follow up",
              },
            ],
          })
        }
      >
        {children}
      </button>
    ),
  },
  useExternalStoreRuntime: (runtime: typeof assistantRuntime.current) => {
    assistantRuntime.current = runtime;
    return runtime;
  },
}));

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

const conversation = {
  id: "chat-1",
  sessionId: "default",
  projectId: "project-1",
  worktreeId: "worktree-1",
  provider: "codex" as const,
  providerThreadId: "thread-1",
  title: "Codex Chat",
  selectedModel: null,
  selectedEffort: null,
  selectedPermissionMode: null,
  createdAt: 10,
  updatedAt: 20,
  lastActivityAt: 20,
  lastMessageAt: 20,
  openTabId: "tab-chat-1",
  lastRunState: "completed" as const,
  lastError: null,
  lastReconciliationState: "not_needed" as const,
  lastReconciliationError: null,
  pendingRequestCount: 1,
  latestPendingRequestId: "request-1",
  latestPendingRequestKind: "command_approval" as const,
  latestPendingRequestStatus: "pending" as const,
  hasPendingRequestAttention: true,
  contextUsedTokens: 4200,
  contextMaxTokens: 10000,
  contextPercentUsed: 42,
  contextUpdatedAt: 20,
  revision: 1,
};

const userMessage: ChatMessage = {
  id: "message-user-1",
  conversationId: "chat-1",
  turnId: "turn-1",
  itemId: null,
  providerTurnId: "provider-turn-1",
  providerItemId: null,
  role: "user",
  status: "completed",
  contentText: "Please run the tests",
  reasoningText: "",
  sequence: 1,
  createdAt: 10,
  updatedAt: 10,
};

const assistantMessage: ChatMessage = {
  id: "message-assistant-1",
  conversationId: "chat-1",
  turnId: "turn-1",
  itemId: "item-agent-1",
  providerTurnId: "provider-turn-1",
  providerItemId: "provider-item-agent-1",
  role: "assistant",
  status: "completed",
  contentText: "The tests passed.",
  reasoningText: "I checked the relevant test output first.",
  sequence: 2,
  createdAt: 12,
  updatedAt: 20,
};

function makeDetail(
  overrides: Partial<ChatConversationDetail> = {},
): ChatConversationDetail {
  const detail: ChatConversationDetail = {
    conversation,
    messages: [userMessage, assistantMessage],
    turns: [
      {
        id: "turn-1",
        conversationId: "chat-1",
        runId: "run-1",
        userMessageId: "message-user-1",
        assistantMessageId: "message-assistant-1",
        providerTurnId: "provider-turn-1",
        status: "completed",
        startedAt: 10,
        completedAt: 20,
        errorMessage: null,
        reconciliationStatus: "not_needed",
        reconciledAt: null,
        reconciliationError: null,
        createdAt: 10,
        updatedAt: 20,
      },
    ],
    items: [
      {
        id: "item-agent-1",
        conversationId: "chat-1",
        turnId: "turn-1",
        providerTurnId: "provider-turn-1",
        providerItemId: "provider-item-agent-1",
        kind: "agent_message",
        status: "completed",
        role: "assistant",
        sequence: 2,
        title: null,
        summary: null,
        metadataJson: "{}",
        createdAt: 12,
        updatedAt: 20,
        completedAt: 20,
      },
      {
        id: "item-command-1",
        conversationId: "chat-1",
        turnId: "turn-1",
        providerTurnId: "provider-turn-1",
        providerItemId: "provider-item-command-1",
        kind: "command_execution",
        status: "completed",
        role: null,
        sequence: 3,
        title: "Run `bun test`",
        summary: "tests completed",
        metadataJson: "{}",
        createdAt: 13,
        updatedAt: 18,
        completedAt: 18,
      },
    ],
    plans: [
      {
        id: "plan-1",
        conversationId: "chat-1",
        turnId: "turn-1",
        providerTurnId: "provider-turn-1",
        providerItemId: null,
        kind: "active_task",
        status: "completed",
        sequence: 4,
        contentText: "",
        ownerGeneration: 1,
        stepsJson: JSON.stringify([
          { text: "Inspect chat state", status: "completed" },
          { text: "Run focused tests", status: "completed" },
        ]),
        metadataJson: "{}",
        createdAt: 14,
        updatedAt: 18,
        completedAt: 18,
      },
    ],
    diffSummaries: [
      {
        id: "diff-1",
        conversationId: "chat-1",
        turnId: "turn-1",
        providerTurnId: "provider-turn-1",
        sequence: 5,
        changedFileCount: 1,
        additions: 12,
        deletions: 3,
        files: [
          {
            path: "apps/web/src/components/AgentChatTab.tsx",
            originalPath: null,
            additions: 12,
            deletions: 3,
            changeType: "modified",
          },
        ],
        metadataJson: "{}",
        ownerGeneration: 1,
        createdAt: 15,
        updatedAt: 18,
      },
    ],
    contextUsage: {
      id: "context-1",
      conversationId: "chat-1",
      providerThreadId: "thread-1",
      usedTokens: 4200,
      maxTokens: 10000,
      percentUsed: 42,
      totalProcessedTokens: 5000,
      metadataJson: "{}",
      updatedAt: 18,
    },
    pendingRequests: [
      {
        id: "request-1",
        conversationId: "chat-1",
        turnId: "turn-1",
        itemId: "item-command-1",
        providerRequestId: "provider-request-1",
        providerTurnId: "provider-turn-1",
        providerItemId: "provider-item-command-1",
        method: "item/commandExecution/requestApproval",
        kind: "command_approval",
        status: "pending",
        decision: null,
        ownerGeneration: 1,
        sequence: 6,
        payloadJson: JSON.stringify({
          command: "bun test",
          cwd: "/repo",
          reason: "Codex wants to verify the chat UI.",
        }),
        responseJson: null,
        errorMessage: null,
        createdAt: 17,
        updatedAt: 17,
        resolvedAt: null,
      },
    ],
    latestReconciliation: {
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
    },
    latestRun: {
      id: "run-1",
      conversationId: "chat-1",
      turnId: "turn-1",
      providerTurnId: "provider-turn-1",
      status: "completed",
      startedAt: 10,
      finishedAt: 20,
      errorMessage: null,
    },
  };
  return { ...detail, ...overrides };
}

function mockModels() {
  apiMocks.listChatModels.mockResolvedValue([
    {
      id: "gpt-5.4",
      model: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "Default",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
        { reasoningEffort: "medium", description: "Medium" },
      ],
    },
  ]);
}

async function renderChat(detail = makeDetail()) {
  apiMocks.getChat.mockResolvedValue(detail);
  apiMocks.getChatActivity.mockResolvedValue({
    item: detail.items.find((item) => item.id === "item-command-1"),
    outputs: [
      {
        id: "output-1",
        conversationId: "chat-1",
        itemId: "item-command-1",
        streamKind: "stdout",
        sequence: 1,
        contentText: "test output\n",
        byteCount: 12,
        createdAt: 18,
        updatedAt: 18,
      },
    ],
  });
  mockModels();
  render(<AgentChatTabView tab={makeTab()} visible />);
  await screen.findByText("Please run the tests");
}

function defineScrollMetrics(
  viewport: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
) {
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

describe("AgentChatTab", () => {
  beforeEach(() => {
    resetChatStoreForTests();
    resetTabStoreForTests();
    assistantRuntime.composerValue = "";
    assistantRuntime.current = null;
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
    apiMocks.interruptChat.mockResolvedValue(undefined);
    apiMocks.patchChatSettings.mockResolvedValue(conversation);
    apiMocks.sendChatMessage.mockResolvedValue(undefined);
  });

  it("renders the normalized timeline surfaces with accessible status", async () => {
    await renderChat();

    expect(screen.getByRole("list", { name: "Chat timeline" })).toBeVisible();
    expect(screen.getByText("The tests passed.")).toBeVisible();
    expect(screen.getByText("Thinking")).toBeVisible();
    expect(screen.getByText("Run `bun test`")).toBeVisible();
    expect(screen.getAllByText("Command approval").length).toBeGreaterThan(0);
    expect(screen.getByText("Plan")).toBeVisible();
    expect(screen.getByText("Changes")).toBeVisible();
    expect(screen.getByRole("meter", { name: /42%/ })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reconciling Codex thread state",
    );
  });

  it("uses fallback text for whitespace-only assistant responses", async () => {
    await renderChat(
      makeDetail({
        messages: [
          userMessage,
          {
            ...assistantMessage,
            contentText: "   ",
          },
        ],
        pendingRequests: [],
        latestReconciliation: null,
      }),
    );

    expect(
      await screen.findByText("Codex completed without returning a response."),
    ).toBeVisible();
  });

  it("does not show the new chat empty state before history loads", async () => {
    apiMocks.getChat.mockReturnValue(new Promise(() => {}));
    apiMocks.getChatActivity.mockResolvedValue({ item: null, outputs: [] });
    mockModels();

    render(<AgentChatTabView tab={makeTab()} visible />);

    expect(screen.queryByText("New Chat")).toBeNull();
    expect(await screen.findByText("Loading chat history...")).toBeVisible();
  });

  it("groups completed thinking and activity before the final answer", async () => {
    await renderChat(
      makeDetail({
        pendingRequests: [],
        latestReconciliation: null,
      }),
    );

    const rows = screen.getAllByTestId("chat-timeline-row");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "User message: completed",
      "Codex work: Completed",
      "Codex response: completed",
    ]);

    const workRow = screen.getByLabelText("Codex work: Completed");
    const assistantRow = screen.getByLabelText("Codex response: completed");
    expect(
      within(workRow).getByText("Codex worked for this turn"),
    ).toBeVisible();
    expect(
      within(workRow).getByTestId("chat-work-reasoning-preview"),
    ).toHaveTextContent("I checked the relevant test output first.");
    expect(within(assistantRow).queryByText("Thinking")).toBeNull();
    expect(within(assistantRow).getByText("The tests passed.")).toBeVisible();

    fireEvent.click(within(workRow).getByLabelText("Expand Codex work"));
    expect(within(workRow).getByText("Thinking")).toBeVisible();
    expect(within(workRow).getByText("Run `bun test`")).toBeVisible();
    expect(within(workRow).getByText("Plan")).toBeVisible();
    expect(within(workRow).getByText("Changes")).toBeVisible();
  });

  it("keeps a work group open after it was active during streaming", async () => {
    await renderChat(
      makeDetail({
        pendingRequests: [],
        latestReconciliation: null,
      }),
    );

    expect(screen.getByLabelText("Expand Codex work")).toBeVisible();

    act(() => {
      useChatStore.setState((state) => ({
        turnsById: {
          ...state.turnsById,
          "turn-1": {
            ...state.turnsById["turn-1"]!,
            status: "running",
            completedAt: null,
          },
        },
      }));
    });

    expect(screen.getByLabelText("Collapse Codex work")).toBeVisible();

    act(() => {
      useChatStore.setState((state) => ({
        turnsById: {
          ...state.turnsById,
          "turn-1": {
            ...state.turnsById["turn-1"]!,
            status: "completed",
            completedAt: 20,
          },
        },
      }));
    });

    expect(screen.getByLabelText("Collapse Codex work")).toBeVisible();
    expect(screen.getByText("Thinking")).toBeVisible();
  });

  it("shows active work without an empty assistant bubble", async () => {
    await renderChat(
      makeDetail({
        messages: [
          userMessage,
          {
            ...assistantMessage,
            status: "streaming",
            contentText: "",
            reasoningText: "I am checking the repo before answering.",
          },
        ],
        items: [
          {
            ...makeDetail().items[0],
            status: "streaming",
          },
          {
            ...makeDetail().items[1],
            status: "streaming",
          },
        ],
        pendingRequests: [],
        latestReconciliation: null,
      }),
    );

    expect(screen.getByLabelText("Codex work: Working")).toBeVisible();
    expect(screen.queryByLabelText("Codex response: streaming")).toBeNull();
    expect(
      screen.getByText("I am checking the repo before answering."),
    ).toBeVisible();
    expect(screen.getByText("Run `bun test`")).toBeVisible();
  });

  it("contains inactive rows while keeping active rows fully rendered", async () => {
    await renderChat(
      makeDetail({
        messages: [
          userMessage,
          {
            ...assistantMessage,
            status: "streaming",
            contentText: "Streaming answer",
          },
        ],
        pendingRequests: [],
        latestReconciliation: null,
      }),
    );

    const rows = screen.getAllByTestId("chat-timeline-row");
    const inactiveRow = rows.find(
      (row) => row.getAttribute("data-active") === "false",
    );
    const activeRow = rows.find(
      (row) => row.getAttribute("data-active") === "true",
    );

    expect(inactiveRow).toHaveStyle({ contentVisibility: "auto" });
    expect(activeRow).not.toHaveStyle({ contentVisibility: "auto" });
  });

  it("auto-follows new rows only when the user is near the bottom", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    await renderChat(
      makeDetail({ pendingRequests: [], latestReconciliation: null }),
    );

    const viewport = screen
      .getByTestId("chat-scroll-root")
      .querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    expect(viewport).toBeTruthy();
    defineScrollMetrics(viewport!, 1000, 500);
    viewport!.scrollTop = 450;
    fireEvent.scroll(viewport!);

    act(() => {
      const nextMessage = {
        ...assistantMessage,
        id: "message-new",
        contentText: "A later answer",
        sequence: 99,
        createdAt: 99,
        updatedAt: 99,
      };
      useChatStore.setState((state) => ({
        messagesById: {
          ...state.messagesById,
          [nextMessage.id]: nextMessage,
        },
        messageIdsByConversationId: {
          ...state.messageIdsByConversationId,
          "chat-1": [
            ...state.messageIdsByConversationId["chat-1"],
            nextMessage.id,
          ],
        },
        timelineIdsByConversationId: {
          ...state.timelineIdsByConversationId,
          "chat-1": [
            ...selectChatTimelineIds(state, "chat-1"),
            `message:${nextMessage.id}`,
          ],
        },
      }));
    });
    expect(viewport!.scrollTop).toBe(500);

    viewport!.scrollTop = 100;
    fireEvent.scroll(viewport!);
    act(() => {
      const nextMessage = {
        ...assistantMessage,
        id: "message-newer",
        contentText: "Another later answer",
        sequence: 100,
        createdAt: 100,
        updatedAt: 100,
      };
      useChatStore.setState((state) => ({
        messagesById: {
          ...state.messagesById,
          [nextMessage.id]: nextMessage,
        },
        messageIdsByConversationId: {
          ...state.messageIdsByConversationId,
          "chat-1": [
            ...state.messageIdsByConversationId["chat-1"],
            nextMessage.id,
          ],
        },
        timelineIdsByConversationId: {
          ...state.timelineIdsByConversationId,
          "chat-1": [
            ...selectChatTimelineIds(state, "chat-1"),
            `message:${nextMessage.id}`,
          ],
        },
      }));
    });
    expect(viewport!.scrollTop).toBe(100);
    requestAnimationFrameSpy.mockRestore();
  });

  it("keeps draft input enabled while blocking sends for pending requests", async () => {
    await renderChat(makeDetail({ latestReconciliation: null }));

    expect(screen.getByLabelText("Message Codex")).toBeEnabled();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
    expect(screen.getByLabelText("Send message")).toHaveAttribute(
      "title",
      "Codex is waiting for approval or input.",
    );
  });

  it("focuses the active blocking request panel with Alt+A", async () => {
    await renderChat(makeDetail({ latestReconciliation: null }));

    fireEvent.keyDown(screen.getByTestId("agent-chat-tab"), {
      altKey: true,
      key: "a",
    });

    const focused = document.activeElement as HTMLElement;
    expect(focused).toHaveAttribute("data-chat-pending-action", "primary");
    expect(
      focused.closest('[data-chat-pending-request-panel="true"]'),
    ).not.toBeNull();
  });

  it("supports local keyboard focus and interrupt shortcuts", async () => {
    await renderChat(
      makeDetail({
        messages: [
          userMessage,
          {
            ...assistantMessage,
            status: "streaming",
            contentText: "Streaming answer",
          },
        ],
        pendingRequests: [],
        latestRun: {
          id: "run-1",
          conversationId: "chat-1",
          turnId: "turn-1",
          providerTurnId: "provider-turn-1",
          status: "running",
          startedAt: 10,
          finishedAt: null,
          errorMessage: null,
        },
        latestReconciliation: null,
      }),
    );

    const root = screen.getByTestId("agent-chat-tab");
    fireEvent.keyDown(root, { key: "/" });
    expect(screen.getByLabelText("Message Codex")).toHaveFocus();

    fireEvent.keyDown(root, { key: "Escape" });
    await waitFor(() => {
      expect(apiMocks.interruptChat).toHaveBeenCalledWith("chat-1");
    });
  });
});
