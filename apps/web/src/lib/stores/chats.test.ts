// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandler, SseEventName } from "@/lib/events";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import {
  initializeChatStore,
  resetChatStoreForTests,
  useChatStore,
} from "./chats";

const mockGetChat = vi.fn();
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
  revision: 1,
};

const detail = {
  conversation,
  messages: [
    {
      id: "message-1",
      conversationId: "chat-1",
      providerTurnId: "turn-1",
      role: "assistant" as const,
      status: "streaming" as const,
      contentText: "Hello",
      reasoningText: "",
      sequence: 1,
      createdAt: 10,
      updatedAt: 10,
    },
  ],
  latestRun: {
    id: "run-1",
    conversationId: "chat-1",
    providerTurnId: "turn-1",
    status: "running" as const,
    startedAt: 10,
    finishedAt: null,
    errorMessage: null,
  },
};

describe("chat store", () => {
  beforeEach(() => {
    mockEvents = new MockEventClient();
    mockGetChat.mockReset();
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
      chat_conversations: [conversation],
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
    });

    expect(useChatStore.getState().conversationsById["chat-1"]?.title).toBe(
      "New Chat",
    );
    expect(
      useChatStore.getState().runtimesByConversationId["chat-1"]?.lifecycle,
    ).toBe("ready");
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

    mockEvents.emit("chat_message_delta", {
      session_id: "default",
      conversation_id: "chat-1",
      message_id: "message-1",
      delta: " world",
      revision: 2n,
    });

    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.detail
        ?.messages[0]?.contentText,
    ).toBe("Hello world");

    mockEvents.emit("chat_message_updated", {
      session_id: "default",
      conversation_id: "chat-1",
      message: {
        ...detail.messages[0],
        reasoningText: "Inspecting the worktree state",
      },
    });

    expect(
      useChatStore.getState().detailsByConversationId["chat-1"]?.detail
        ?.messages[0]?.reasoningText,
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
