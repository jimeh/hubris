// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import {
  flushChatStoreSseBatchForTests,
  initializeChatStore,
  resetChatStoreForTests,
  selectChatItemOutputIds,
  selectChatMessageIds,
  selectChatTimelineIds,
  useChatStore,
} from "./chats";

const mockGetChat = vi.fn();
const mockGetChatActivity = vi.fn();
const mockListChatModels = vi.fn();
const mockPatchChatSettings = vi.fn();
const mockSendChatMessage = vi.fn();
const mockInterruptChat = vi.fn();

class MockEventClient {
  private handlers = new Map<SseEventName, Set<EventHandler<unknown>>>();

  on<K extends SseEventName>(
    event: K,
    handler: EventHandler<unknown>,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);
    return () =>
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit(event: SseEventName, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }
}

let mockEvents: MockEventClient;

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getChat: (...args: unknown[]) => mockGetChat(...args),
    getChatActivity: (...args: unknown[]) => mockGetChatActivity(...args),
    listChatModels: (...args: unknown[]) => mockListChatModels(...args),
    patchChatSettings: (...args: unknown[]) => mockPatchChatSettings(...args),
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
    interruptChat: (...args: unknown[]) => mockInterruptChat(...args),
  };
});

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) {
        mockEvents = new MockEventClient();
      }
      return mockEvents;
    },
  };
});

const conversation = {
  id: "chat-1",
  sessionId: "default",
  projectId: "project-1",
  worktreeId: "worktree-1",
  provider: "codex" as const,
  providerThreadId: "thread-1",
  title: "New Chat",
  selectedModel: null,
  selectedEffort: null,
  selectedPermissionMode: null,
  createdAt: 10,
  updatedAt: 10,
  lastActivityAt: 10,
  lastMessageAt: 10,
  openTabId: null,
  lastRunState: "completed" as const,
  lastError: null,
  pendingRequestCount: 0,
  latestPendingRequestId: null,
  latestPendingRequestKind: null,
  latestPendingRequestStatus: null,
  hasPendingRequestAttention: false,
  contextUsedTokens: null,
  contextMaxTokens: null,
  contextPercentUsed: null,
  contextUpdatedAt: null,
  revision: 1,
};

const detail = {
  conversation,
  messages: [
    {
      id: "message-1",
      conversationId: "chat-1",
      turnId: "turn-local-1",
      itemId: "item-1",
      providerTurnId: "turn-1",
      providerItemId: "provider-item-1",
      role: "assistant" as const,
      status: "streaming" as const,
      contentText: "Hello",
      reasoningText: "",
      sequence: 1,
      createdAt: 10,
      updatedAt: 10,
    },
  ],
  turns: [
    {
      id: "turn-local-1",
      conversationId: "chat-1",
      runId: "run-1",
      userMessageId: "user-message-1",
      assistantMessageId: "message-1",
      providerTurnId: "turn-1",
      status: "running" as const,
      startedAt: 10,
      completedAt: null,
      errorMessage: null,
      createdAt: 10,
      updatedAt: 10,
    },
  ],
  items: [
    {
      id: "item-1",
      conversationId: "chat-1",
      turnId: "turn-local-1",
      providerTurnId: "turn-1",
      providerItemId: "provider-item-1",
      kind: "agent_message" as const,
      status: "streaming" as const,
      role: "assistant" as const,
      sequence: 1,
      title: null,
      summary: null,
      metadataJson: "{}",
      createdAt: 10,
      updatedAt: 10,
      completedAt: null,
    },
  ],
  plans: [],
  diffSummaries: [],
  contextUsage: null,
  pendingRequests: [],
  latestRun: {
    id: "run-1",
    conversationId: "chat-1",
    turnId: "turn-local-1",
    providerTurnId: "turn-1",
    status: "running" as const,
    startedAt: 10,
    finishedAt: null,
    errorMessage: null,
  },
};

const commandItem = {
  id: "item-command-1",
  conversationId: "chat-1",
  turnId: "turn-local-1",
  providerTurnId: "turn-1",
  providerItemId: "provider-command-1",
  kind: "command_execution" as const,
  status: "streaming" as const,
  role: null,
  sequence: 2,
  title: "Run `cargo test`",
  summary: "running tests",
  metadataJson: "{}",
  createdAt: 11,
  updatedAt: 11,
  completedAt: null,
};

const commandOutput = {
  id: "output-1",
  conversationId: "chat-1",
  itemId: "item-command-1",
  streamKind: "stdout",
  sequence: 1,
  contentText: "test output\n",
  byteCount: 12,
  createdAt: 12,
  updatedAt: 12,
};

const pendingRequest = {
  id: "request-1",
  conversationId: "chat-1",
  turnId: "turn-local-1",
  itemId: "item-command-1",
  providerRequestId: "provider-request-1",
  providerTurnId: "turn-1",
  providerItemId: "provider-command-1",
  method: "item/commandExecution/requestApproval",
  kind: "command_approval" as const,
  status: "pending" as const,
  decision: null,
  payloadJson: JSON.stringify({
    command: ["cargo", "test"],
    cwd: "/tmp/project",
  }),
  responseJson: null,
  errorMessage: null,
  ownerGeneration: 1,
  sequence: 3,
  createdAt: 13,
  updatedAt: 13,
  resolvedAt: null,
};

const plan = {
  id: "plan-1",
  conversationId: "chat-1",
  turnId: "turn-local-1",
  itemId: null,
  providerTurnId: "turn-1",
  providerItemId: null,
  kind: "active_task" as const,
  status: "streaming" as const,
  contentText: "",
  stepsJson: JSON.stringify([
    { text: "Inspect current state", status: "completed" },
    { text: "Patch implementation", status: "in_progress" },
  ]),
  metadataJson: "{}",
  ownerGeneration: 1,
  sequence: 2,
  createdAt: 11,
  updatedAt: 11,
  completedAt: null,
};

const diffSummary = {
  id: "diff-1",
  conversationId: "chat-1",
  turnId: "turn-local-1",
  providerTurnId: "turn-1",
  changedFileCount: 1,
  additions: 8,
  deletions: 2,
  files: [
    {
      path: "apps/web/src/lib/stores/chats.ts",
      originalPath: null,
      changeType: "modified",
      additions: 8,
      deletions: 2,
    },
  ],
  metadataJson: "{}",
  ownerGeneration: 1,
  sequence: 4,
  createdAt: 14,
  updatedAt: 14,
};

const contextUsage = {
  id: "context-1",
  conversationId: "chat-1",
  providerThreadId: "thread-1",
  usedTokens: 1200,
  maxTokens: 12000,
  percentUsed: 10,
  totalProcessedTokens: 3000,
  metadataJson: "{}",
  updatedAt: 15,
};

describe("chat store", () => {
  beforeEach(() => {
    mockEvents = new MockEventClient();
    mockGetChat.mockReset();
    mockGetChatActivity.mockReset();
    mockListChatModels.mockReset();
    mockPatchChatSettings.mockReset();
    mockSendChatMessage.mockReset();
    mockInterruptChat.mockReset();
    resetTabStoreForTests();
    resetChatStoreForTests();
  });

  it("hydrates summaries and runtimes from the SSE snapshot", () => {
    initializeChatStore();

    mockEvents.emit("snapshot", {
      chat_app_server: {
        lifecycle: "ready",
        lastError: null,
        updatedAt: 10,
      },
      chat_conversations: [conversation],
      chat_context_usage: [contextUsage],
      chat_runtimes: [
        {
          conversationId: "chat-1",
          sessionId: "default",
          projectId: "project-1",
          worktreeId: "worktree-1",
          lifecycle: "ready",
          activeRunId: null,
          activeMessageId: null,
          providerThreadId: "thread-1",
          lastError: null,
          updatedAt: 10,
        },
      ],
      chat_thread_streams: [
        {
          conversationId: "chat-1",
          sessionId: "default",
          projectId: "project-1",
          worktreeId: "worktree-1",
          resumeState: "resumed",
          lifecycle: "ready",
          activeRunId: null,
          activeMessageId: null,
          providerThreadId: "thread-1",
          inactiveDeadlineAt: null,
          lastError: null,
          updatedAt: 10,
        },
      ],
    });

    expect(useChatStore.getState().conversationsById["chat-1"]?.title).toBe(
      "New Chat",
    );
    expect(
      useChatStore.getState().runtimesByConversationId["chat-1"]?.lifecycle,
    ).toBe("ready");
    expect(useChatStore.getState().appServerStatus?.lifecycle).toBe("ready");
    expect(
      useChatStore.getState().contextUsageByConversationId["chat-1"]
        ?.percentUsed,
    ).toBe(10);
    expect(
      useChatStore.getState().threadStreamsByConversationId["chat-1"]
        ?.resumeState,
    ).toBe("resumed");
  });

  it("loads conversation detail, applies deltas, and syncs open tab labels", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue(detail);
    useTabStore.setState({
      tabs: [
        {
          type: "agent_chat",
          id: "tab-1",
          session_id: "default",
          worktree_id: "worktree-1",
          pane_id: "pane-1",
          label: "New Chat",
          position: 1,
          created_at: 10,
          preview: false,
          conversation_id: "chat-1",
        },
      ],
    });

    const loaded = await useChatStore
      .getState()
      .ensureConversationLoaded("chat-1");

    expect(mockGetChat).toHaveBeenCalledWith("chat-1");
    expect(loaded?.messages[0]?.contentText).toBe("Hello");
    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello",
    );

    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: " world",
      revision: 2n,
    });

    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello",
    );

    flushChatStoreSseBatchForTests();

    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello world",
    );

    mockEvents.emit("chat_message_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      message: {
        ...detail.messages[0],
        reasoningText: "Inspecting the worktree state",
      },
    });
    flushChatStoreSseBatchForTests();

    expect(
      useChatStore.getState().messagesById["message-1"]?.reasoningText,
    ).toBe("Inspecting the worktree state");

    mockEvents.emit("chat_conversation_updated", {
      session_id: "default",
      conversation: {
        ...conversation,
        title: "Investigate build failure",
        revision: 2,
      },
    });

    expect(useTabStore.getState().tabs[0]?.label).toBe(
      "Investigate build failure",
    );
  });

  it("hydrates turn/item detail and applies turn/item SSE updates", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue(detail);

    await useChatStore.getState().ensureConversationLoaded("chat-1");

    expect(useChatStore.getState().turnsById["turn-local-1"]?.status).toBe(
      "running",
    );
    expect(useChatStore.getState().itemsById["item-1"]?.status).toBe(
      "streaming",
    );

    mockEvents.emit("chat_turn_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      turn: {
        ...detail.turns[0],
        status: "completed",
        completedAt: 20,
        updatedAt: 20,
      },
    });
    mockEvents.emit("chat_item_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      item: {
        ...detail.items[0],
        status: "completed",
        completedAt: 20,
        updatedAt: 20,
      },
    });
    flushChatStoreSseBatchForTests();

    expect(useChatStore.getState().turnsById["turn-local-1"]?.status).toBe(
      "completed",
    );
    expect(useChatStore.getState().itemsById["item-1"]?.status).toBe(
      "completed",
    );
  });

  it("hydrates and applies plan, diff, and context usage updates", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue({
      ...detail,
      plans: [plan],
      diffSummaries: [diffSummary],
      contextUsage,
    });

    const loaded = await useChatStore
      .getState()
      .ensureConversationLoaded("chat-1");

    expect(loaded?.plans[0]?.id).toBe("plan-1");
    expect(loaded?.diffSummaries[0]?.id).toBe("diff-1");
    expect(loaded?.contextUsage?.percentUsed).toBe(10);
    expect(selectChatTimelineIds(useChatStore.getState(), "chat-1")).toEqual([
      "message:message-1",
      "plan:plan-1",
      "diff:diff-1",
    ]);

    mockEvents.emit("chat_plan_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      plan: {
        ...plan,
        status: "completed",
        updatedAt: 16,
        completedAt: 16,
      },
    });
    mockEvents.emit("chat_diff_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      diff: {
        ...diffSummary,
        changedFileCount: 2,
        updatedAt: 16,
      },
    });
    mockEvents.emit("chat_context_usage_updated", {
      session_id: "default",
      usage: {
        ...contextUsage,
        percentUsed: 22,
        updatedAt: 16,
      },
    });
    flushChatStoreSseBatchForTests();

    expect(useChatStore.getState().plansById["plan-1"]?.status).toBe(
      "completed",
    );
    expect(
      useChatStore.getState().diffSummariesById["diff-1"]?.changedFileCount,
    ).toBe(2);
    expect(
      useChatStore.getState().contextUsageByConversationId["chat-1"]
        ?.percentUsed,
    ).toBe(22);
  });

  it("adds activity items to the chat timeline without changing messages", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue(detail);
    await useChatStore.getState().ensureConversationLoaded("chat-1");

    expect(selectChatTimelineIds(useChatStore.getState(), "chat-1")).toEqual([
      "message:message-1",
    ]);

    mockEvents.emit("chat_activity_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      item: commandItem,
    });
    mockEvents.emit("chat_activity_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      item_id: "item-command-1",
      output: commandOutput,
    });
    flushChatStoreSseBatchForTests();

    expect(selectChatTimelineIds(useChatStore.getState(), "chat-1")).toEqual([
      "message:message-1",
      "activity:item-command-1",
    ]);
    expect(
      selectChatItemOutputIds(useChatStore.getState(), "item-command-1"),
    ).toEqual(["output-1"]);
    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello",
    );
  });

  it("hydrates and applies pending request updates", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue({
      ...detail,
      pendingRequests: [pendingRequest],
    });
    await useChatStore.getState().ensureConversationLoaded("chat-1");

    expect(selectChatTimelineIds(useChatStore.getState(), "chat-1")).toEqual([
      "message:message-1",
      "request:request-1",
    ]);
    expect(
      useChatStore.getState().pendingRequestsById["request-1"]?.status,
    ).toBe("pending");

    mockEvents.emit("chat_pending_request_resolved", {
      session_id: "default",
      request: {
        ...pendingRequest,
        status: "resolved",
        decision: "accept",
        updatedAt: 14,
        resolvedAt: 14,
      },
    });
    flushChatStoreSseBatchForTests();

    expect(
      useChatStore.getState().pendingRequestsById["request-1"]?.status,
    ).toBe("resolved");
  });

  it("lazy-loads persisted activity output details", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue({
      ...detail,
      items: [...detail.items, commandItem],
    });
    mockGetChatActivity.mockResolvedValue({
      item: {
        ...commandItem,
        status: "completed",
        completedAt: 20,
      },
      outputs: [commandOutput],
    });
    await useChatStore.getState().ensureConversationLoaded("chat-1");

    const loaded = await useChatStore
      .getState()
      .ensureActivityLoaded("chat-1", "item-command-1");

    expect(mockGetChatActivity).toHaveBeenCalledWith(
      "chat-1",
      "item-command-1",
    );
    expect(loaded?.outputs[0]?.contentText).toBe("test output\n");
    expect(useChatStore.getState().itemsById["item-command-1"]?.status).toBe(
      "completed",
    );
  });

  it("marks unloaded conversation detail dirty on lazy detail updates", () => {
    initializeChatStore();

    mockEvents.emit("chat_turn_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      turn: detail.turns[0],
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);
    expect(
      selectChatMessageIds(useChatStore.getState(), "chat-1"),
    ).toHaveLength(0);

    resetChatStoreForTests();
    mockEvents = new MockEventClient();
    initializeChatStore();
    mockEvents.emit("chat_item_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      item: detail.items[0],
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);

    resetChatStoreForTests();
    mockEvents = new MockEventClient();
    initializeChatStore();
    mockEvents.emit("chat_activity_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      item_id: "item-command-1",
      output: commandOutput,
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);

    resetChatStoreForTests();
    mockEvents = new MockEventClient();
    initializeChatStore();
    mockEvents.emit("chat_plan_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      plan,
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);

    resetChatStoreForTests();
    mockEvents = new MockEventClient();
    initializeChatStore();
    mockEvents.emit("chat_diff_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      diff: diffSummary,
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);

    resetChatStoreForTests();
    mockEvents = new MockEventClient();
    initializeChatStore();
    mockEvents.emit("chat_context_usage_updated", {
      session_id: "default",
      usage: contextUsage,
    });
    flushChatStoreSseBatchForTests();
    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.needsRefresh,
    ).toBe(true);
  });

  it("returns stable empty message ids for unloaded conversations", () => {
    const first = selectChatMessageIds(useChatStore.getState(), "missing");
    const second = selectChatMessageIds(useChatStore.getState(), "missing");

    expect(first).toBe(second);
    expect(first).toHaveLength(0);
  });

  it("batches message deltas and preserves in-frame event order", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue(detail);
    await useChatStore.getState().ensureConversationLoaded("chat-1");

    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: " world",
      revision: 2n,
    });
    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: "!",
      revision: 3n,
    });

    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello",
    );

    flushChatStoreSseBatchForTests();

    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Hello world!",
    );

    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: " ignored by update",
      revision: 4n,
    });
    mockEvents.emit("chat_message_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      message: {
        ...detail.messages[0],
        status: "completed",
        contentText: "Final",
      },
    });
    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: ".",
      revision: 5n,
    });
    flushChatStoreSseBatchForTests();

    expect(useChatStore.getState().messagesById["message-1"]?.contentText).toBe(
      "Final.",
    );
  });

  it("batches run, turn, and item updates into loaded detail state", async () => {
    initializeChatStore();
    mockGetChat.mockResolvedValue(detail);
    await useChatStore.getState().ensureConversationLoaded("chat-1");

    mockEvents.emit("chat_run_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      run: {
        ...detail.latestRun,
        status: "completed",
        finishedAt: 30,
      },
    });
    mockEvents.emit("chat_turn_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      turn: {
        ...detail.turns[0],
        status: "completed",
        completedAt: 30,
      },
    });
    mockEvents.emit("chat_item_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      item: {
        ...detail.items[0],
        status: "completed",
        completedAt: 30,
      },
    });
    flushChatStoreSseBatchForTests();

    expect(
      useChatStore.getState().latestRunByConversationId["chat-1"]?.status,
    ).toBe("completed");
    expect(useChatStore.getState().turnsById["turn-local-1"]?.status).toBe(
      "completed",
    );
    expect(useChatStore.getState().itemsById["item-1"]?.status).toBe(
      "completed",
    );
  });

  it("loads model options and applies conversation setting updates immediately", async () => {
    initializeChatStore();
    mockListChatModels.mockResolvedValue([
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Default",
        isDefault: true,
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "low",
            description: "Low",
          },
          {
            reasoningEffort: "medium",
            description: "Medium",
          },
        ],
      },
    ]);
    mockPatchChatSettings.mockResolvedValue({
      ...conversation,
      selectedModel: "gpt-5.4",
      selectedEffort: "medium",
      selectedPermissionMode: "full_access",
      revision: 2,
    });

    const models = await useChatStore.getState().ensureModelsLoaded();
    expect(models[0]?.model).toBe("gpt-5.4");

    await useChatStore.getState().updateConversationSettings("chat-1", {
      selectedModel: "gpt-5.4",
      selectedEffort: "medium",
      selectedPermissionMode: "full_access",
    });

    expect(
      useChatStore.getState().conversationsById["chat-1"]?.selectedModel,
    ).toBe("gpt-5.4");
    expect(
      useChatStore.getState().conversationsById["chat-1"]
        ?.selectedPermissionMode,
    ).toBe("full_access");
  });
});
