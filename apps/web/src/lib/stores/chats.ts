import { create } from "zustand";
import {
  getChat,
  interruptChat,
  listChatModels,
  patchChatSettings,
  sendChatMessage,
  type ChatConversationSummary as ApiChatConversationSummary,
  type ChatModelOption as ApiChatModelOption,
  type ChatRuntimeStatus as ApiChatRuntimeStatus,
} from "@/lib/api";
import { getEventClient, type SseEventData } from "@/lib/events";
import { useTabStore } from "@/lib/stores/tabs";
import type {
  ChatConversationDetail,
  ChatConversationSettingsPatch,
  ChatConversationSummary,
  ChatMessage,
  ChatModelOption,
  ChatRuntimeStatus,
  ChatRun,
} from "@/lib/types";

type ConversationDetailState = {
  status: "idle" | "loading" | "loaded" | "error";
  detail: ChatConversationDetail | null;
  error: string | null;
  needsRefresh: boolean;
};

type ChatStoreState = {
  conversationsById: Record<string, ChatConversationSummary>;
  runtimesByConversationId: Record<string, ChatRuntimeStatus>;
  detailsByConversationId: Record<string, ConversationDetailState>;
  modelOptions: ChatModelOption[];
  modelOptionsStatus: "idle" | "loading" | "loaded" | "error";
  modelOptionsError: string | null;
  ensureConversationLoaded: (
    conversationId: string,
  ) => Promise<ChatConversationDetail | null>;
  ensureModelsLoaded: () => Promise<ChatModelOption[]>;
  refreshConversation: (
    conversationId: string,
  ) => Promise<ChatConversationDetail | null>;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  interruptRun: (conversationId: string) => Promise<void>;
  updateConversationSettings: (
    conversationId: string,
    patch: ChatConversationSettingsPatch,
  ) => Promise<void>;
  clearConversationDetail: (conversationId: string) => void;
};

const DEFAULT_DETAIL_STATE: ConversationDetailState = {
  status: "idle",
  detail: null,
  error: null,
  needsRefresh: false,
};

function indexConversations(
  conversations: readonly ApiChatConversationSummary[],
): Record<string, ChatConversationSummary> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
}

function indexRuntimes(
  runtimes: readonly ApiChatRuntimeStatus[],
): Record<string, ChatRuntimeStatus> {
  return Object.fromEntries(
    runtimes.map((runtime) => [runtime.conversationId, runtime]),
  );
}

function normalizeModelOptions(
  models: readonly ApiChatModelOption[],
): ChatModelOption[] {
  return [...models].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

function sortRuns(runs: readonly ChatRun[]): ChatRun[] {
  return [...runs].sort((left, right) => right.startedAt - left.startedAt);
}

function mergeConversationIntoOpenTabs(
  conversation: ChatConversationSummary,
): void {
  useTabStore.setState((state) => {
    const nextTabs = state.tabs.map((tab) =>
      tab.type === "agent_chat" &&
      tab.conversation_id === conversation.id &&
      tab.label !== conversation.title
        ? { ...tab, label: conversation.title }
        : tab,
    );

    const changed = nextTabs.some((tab, index) => tab !== state.tabs[index]);
    return changed ? { tabs: nextTabs } : state;
  });
}

function upsertMessage(
  detail: ChatConversationDetail,
  message: ChatMessage,
): ChatConversationDetail {
  const messages = sortMessages([
    ...detail.messages.filter((existing) => existing.id !== message.id),
    message,
  ]);
  return { ...detail, messages };
}

function upsertRun(
  detail: ChatConversationDetail,
  run: ChatRun,
): ChatConversationDetail {
  const runs = [detail.latestRun].filter(Boolean) as ChatRun[];
  const latestRun =
    sortRuns([...runs.filter((existing) => existing.id !== run.id), run])[0] ??
    null;
  return { ...detail, latestRun };
}

function patchMessageDelta(
  detail: ChatConversationDetail,
  messageId: string,
  delta: string,
): ChatConversationDetail | null {
  const message = detail.messages.find(
    (candidate) => candidate.id === messageId,
  );
  if (!message) {
    return null;
  }

  return upsertMessage(detail, {
    ...message,
    contentText: `${message.contentText}${delta}`,
  });
}

function markConversationDirty(
  state: ChatStoreState,
  conversationId: string,
): Partial<ChatStoreState> {
  const current =
    state.detailsByConversationId[conversationId] ?? DEFAULT_DETAIL_STATE;
  return {
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: {
        ...current,
        needsRefresh: true,
      },
    },
  };
}

function setDetail(
  conversationId: string,
  detail: ChatConversationDetail,
): void {
  useChatStore.setState((state) => ({
    conversationsById: {
      ...state.conversationsById,
      [conversationId]: detail.conversation,
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: {
        status: "loaded",
        detail: {
          ...detail,
          messages: sortMessages(detail.messages),
        },
        error: null,
        needsRefresh: false,
      },
    },
  }));
  mergeConversationIntoOpenTabs(detail.conversation);
}

async function loadConversation(
  conversationId: string,
): Promise<ChatConversationDetail | null> {
  useChatStore.setState((state) => ({
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: {
        ...(state.detailsByConversationId[conversationId] ??
          DEFAULT_DETAIL_STATE),
        status: "loading",
        error: null,
      },
    },
  }));

  try {
    const detail = await getChat(conversationId);
    setDetail(conversationId, detail);
    return detail;
  } catch (error) {
    useChatStore.setState((state) => ({
      detailsByConversationId: {
        ...state.detailsByConversationId,
        [conversationId]: {
          ...(state.detailsByConversationId[conversationId] ??
            DEFAULT_DETAIL_STATE),
          status: "error",
          error: error instanceof Error ? error.message : "Failed to load chat",
        },
      },
    }));
    return null;
  }
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  conversationsById: {},
  runtimesByConversationId: {},
  detailsByConversationId: {},
  modelOptions: [],
  modelOptionsStatus: "idle",
  modelOptionsError: null,
  async ensureConversationLoaded(conversationId) {
    const current = get().detailsByConversationId[conversationId];
    if (
      current?.status === "loaded" &&
      current.detail &&
      !current.needsRefresh
    ) {
      return current.detail;
    }
    if (current?.status === "loading") {
      return current.detail;
    }
    return loadConversation(conversationId);
  },
  async ensureModelsLoaded() {
    if (get().modelOptionsStatus === "loaded") {
      return get().modelOptions;
    }
    if (get().modelOptionsStatus === "loading") {
      return get().modelOptions;
    }

    set({
      modelOptionsStatus: "loading",
      modelOptionsError: null,
    });
    try {
      const models = normalizeModelOptions(await listChatModels());
      set({
        modelOptions: models,
        modelOptionsStatus: "loaded",
        modelOptionsError: null,
      });
      return models;
    } catch (error) {
      set({
        modelOptionsStatus: "error",
        modelOptionsError:
          error instanceof Error ? error.message : "Failed to load models",
      });
      return [];
    }
  },
  async refreshConversation(conversationId) {
    return loadConversation(conversationId);
  },
  async sendMessage(conversationId, text) {
    await sendChatMessage(conversationId, text);
  },
  async interruptRun(conversationId) {
    await interruptChat(conversationId);
  },
  async updateConversationSettings(conversationId, patch) {
    const summary = await patchChatSettings(conversationId, patch);
    handleConversationEvent({
      session_id: summary.sessionId,
      conversation: summary,
    });
  },
  clearConversationDetail(conversationId) {
    set((state) => {
      if (!(conversationId in state.detailsByConversationId)) {
        return state;
      }
      const next = { ...state.detailsByConversationId };
      delete next[conversationId];
      return { detailsByConversationId: next };
    });
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

function handleConversationEvent(
  data:
    | SseEventData<"chat_conversation_created">
    | SseEventData<"chat_conversation_updated">,
): void {
  useChatStore.setState((state) => {
    const details = state.detailsByConversationId[data.conversation.id];
    return {
      conversationsById: {
        ...state.conversationsById,
        [data.conversation.id]: data.conversation,
      },
      detailsByConversationId: details?.detail
        ? {
            ...state.detailsByConversationId,
            [data.conversation.id]: {
              ...details,
              detail: {
                ...details.detail,
                conversation: data.conversation,
              },
            },
          }
        : state.detailsByConversationId,
    };
  });
  mergeConversationIntoOpenTabs(data.conversation);
}

function handleRuntimeEvent(data: SseEventData<"chat_runtime_updated">): void {
  useChatStore.setState((state) => ({
    runtimesByConversationId: {
      ...state.runtimesByConversationId,
      [data.runtime.conversationId]: data.runtime,
    },
  }));
}

function handleMessageUpdated(
  data: SseEventData<"chat_message_updated">,
): void {
  useChatStore.setState((state) => {
    const current = state.detailsByConversationId[data.conversation_id];
    if (!current?.detail) {
      return markConversationDirty(state, data.conversation_id);
    }

    return {
      detailsByConversationId: {
        ...state.detailsByConversationId,
        [data.conversation_id]: {
          ...current,
          detail: upsertMessage(current.detail, data.message),
          needsRefresh: false,
        },
      },
    };
  });
}

function handleRunUpdated(data: SseEventData<"chat_run_updated">): void {
  useChatStore.setState((state) => {
    const current = state.detailsByConversationId[data.conversation_id];
    if (!current?.detail) {
      return markConversationDirty(state, data.conversation_id);
    }

    return {
      detailsByConversationId: {
        ...state.detailsByConversationId,
        [data.conversation_id]: {
          ...current,
          detail: upsertRun(current.detail, data.run),
          needsRefresh: false,
        },
      },
    };
  });
}

function handleMessageDelta(data: SseEventData<"chat_message_delta">): void {
  useChatStore.setState((state) => {
    const current = state.detailsByConversationId[data.conversation_id];
    if (!current?.detail) {
      return markConversationDirty(state, data.conversation_id);
    }

    const nextDetail = patchMessageDelta(
      current.detail,
      data.message_id,
      data.delta,
    );
    if (!nextDetail) {
      return markConversationDirty(state, data.conversation_id);
    }

    return {
      detailsByConversationId: {
        ...state.detailsByConversationId,
        [data.conversation_id]: {
          ...current,
          detail: nextDetail,
          needsRefresh: false,
        },
      },
    };
  });
}

export function initializeChatStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      const nextConversations = indexConversations(data.chat_conversations);
      useChatStore.setState((state) => ({
        conversationsById: nextConversations,
        runtimesByConversationId: indexRuntimes(data.chat_runtimes),
        detailsByConversationId: Object.fromEntries(
          Object.entries(state.detailsByConversationId).filter(
            ([conversationId]) => conversationId in nextConversations,
          ),
        ),
      }));
    }),
    events.on("chat_conversation_created", handleConversationEvent),
    events.on("chat_conversation_updated", handleConversationEvent),
    events.on("chat_runtime_updated", handleRuntimeEvent),
    events.on("chat_message_updated", handleMessageUpdated),
    events.on("chat_message_delta", handleMessageDelta),
    events.on("chat_run_updated", handleRunUpdated),
  ];
}

export function resetChatStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useChatStore.setState({
    conversationsById: {},
    runtimesByConversationId: {},
    detailsByConversationId: {},
    modelOptions: [],
    modelOptionsStatus: "idle",
    modelOptionsError: null,
  });
}
