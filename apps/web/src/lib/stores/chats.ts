import { create } from "zustand";
import {
  getChat,
  getChatActivity,
  interruptChat,
  listChatModels,
  patchChatSettings,
  resolveChatPendingRequest,
  sendChatMessage,
  type ChatConversationSummary as ApiChatConversationSummary,
  type ChatModelOption as ApiChatModelOption,
  type ChatRuntimeStatus as ApiChatRuntimeStatus,
  type ChatThreadStreamStatus as ApiChatThreadStreamStatus,
} from "@/lib/api";
import { getEventClient, type SseEventData } from "@/lib/events";
import { useTabStore } from "@/lib/stores/tabs";
import type {
  ChatAppServerStatus,
  ChatActivityDetail,
  ChatContextUsage,
  ChatConversationDetail,
  ChatConversationSettingsPatch,
  ChatConversationSummary,
  ChatDiffSummary,
  ChatItem,
  ChatItemOutput,
  ChatMessage,
  ChatModelOption,
  ChatPendingRequest,
  ChatPendingRequestDecision,
  ChatPendingRequestSummary,
  ChatPlan,
  ChatRun,
  ChatRuntimeStatus,
  ChatThreadStreamStatus,
  ChatTurn,
} from "@/lib/types";

type ConversationDetailState = {
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  needsRefresh: boolean;
};

type ActivityDetailState = {
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
};

type ChatStoreState = {
  appServerStatus: ChatAppServerStatus | null;
  conversationsById: Record<string, ChatConversationSummary>;
  runtimesByConversationId: Record<string, ChatRuntimeStatus>;
  threadStreamsByConversationId: Record<string, ChatThreadStreamStatus>;
  detailsByConversationId: Record<string, ConversationDetailState>;
  messageIdsByConversationId: Record<string, string[]>;
  messagesById: Record<string, ChatMessage>;
  turnIdsByConversationId: Record<string, string[]>;
  turnsById: Record<string, ChatTurn>;
  itemIdsByConversationId: Record<string, string[]>;
  itemsById: Record<string, ChatItem>;
  timelineIdsByConversationId: Record<string, string[]>;
  outputIdsByItemId: Record<string, string[]>;
  outputsById: Record<string, ChatItemOutput>;
  activityDetailsByItemId: Record<string, ActivityDetailState>;
  planIdsByConversationId: Record<string, string[]>;
  plansById: Record<string, ChatPlan>;
  diffSummaryIdsByConversationId: Record<string, string[]>;
  diffSummariesById: Record<string, ChatDiffSummary>;
  contextUsageByConversationId: Record<string, ChatContextUsage>;
  pendingRequestIdsByConversationId: Record<string, string[]>;
  pendingRequestsById: Record<string, ChatPendingRequest>;
  pendingRequestSummariesById: Record<string, ChatPendingRequestSummary>;
  latestRunByConversationId: Record<string, ChatRun | null>;
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
  ensureActivityLoaded: (
    conversationId: string,
    itemId: string,
  ) => Promise<ChatActivityDetail | null>;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  interruptRun: (conversationId: string) => Promise<void>;
  resolvePendingRequest: (
    conversationId: string,
    requestId: string,
    decision: ChatPendingRequestDecision,
    value?: unknown,
  ) => Promise<void>;
  updateConversationSettings: (
    conversationId: string,
    patch: ChatConversationSettingsPatch,
  ) => Promise<void>;
  clearConversationDetail: (conversationId: string) => void;
};

type ChatBatchEvent =
  | {
      type: "message_delta";
      data: SseEventData<"chat_message_delta">;
    }
  | {
      type: "message_updated";
      data: SseEventData<"chat_message_updated">;
    }
  | {
      type: "run_updated";
      data: SseEventData<"chat_run_updated">;
    }
  | {
      type: "turn_updated";
      data: SseEventData<"chat_turn_updated">;
    }
  | {
      type: "item_updated";
      data: SseEventData<"chat_item_updated">;
    }
  | {
      type: "activity_delta";
      data: SseEventData<"chat_activity_delta">;
    }
  | {
      type: "activity_updated";
      data: SseEventData<"chat_activity_updated">;
    }
  | {
      type: "pending_request_updated";
      data:
        | SseEventData<"chat_pending_request_created">
        | SseEventData<"chat_pending_request_updated">
        | SseEventData<"chat_pending_request_resolved">;
    }
  | {
      type: "plan_updated";
      data: SseEventData<"chat_plan_updated">;
    }
  | {
      type: "diff_updated";
      data: SseEventData<"chat_diff_updated">;
    }
  | {
      type: "context_usage_updated";
      data: SseEventData<"chat_context_usage_updated">;
    };

const DEFAULT_DETAIL_STATE: ConversationDetailState = {
  status: "idle",
  error: null,
  needsRefresh: false,
};

const EMPTY_IDS: readonly string[] = [];
const EMPTY_THREAD_MESSAGES: readonly never[] = [];

const DEFAULT_ACTIVITY_DETAIL_STATE: ActivityDetailState = {
  status: "idle",
  error: null,
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

function indexThreadStreams(
  streams: readonly ApiChatThreadStreamStatus[] = [],
): Record<string, ChatThreadStreamStatus> {
  return Object.fromEntries(
    streams.map((stream) => [stream.conversationId, stream]),
  );
}

function indexPendingRequestSummaries(
  requests: readonly ChatPendingRequestSummary[] = [],
): Record<string, ChatPendingRequestSummary> {
  return Object.fromEntries(requests.map((request) => [request.id, request]));
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

function sortTurns(turns: readonly ChatTurn[]): ChatTurn[] {
  return [...turns].sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt - right.startedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function sortItems(items: readonly ChatItem[]): ChatItem[] {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

function sortOutputs(outputs: readonly ChatItemOutput[]): ChatItemOutput[] {
  return [...outputs].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

function sortPendingRequests(
  requests: readonly ChatPendingRequest[],
): ChatPendingRequest[] {
  return [...requests].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

function sortPlans(plans: readonly ChatPlan[]): ChatPlan[] {
  return [...plans].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

function sortDiffSummaries(
  summaries: readonly ChatDiffSummary[],
): ChatDiffSummary[] {
  return [...summaries].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
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

function messageIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.messageIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function turnIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.turnIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function itemIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.itemIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function pendingRequestIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.pendingRequestIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function planIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.planIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function diffSummaryIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.diffSummaryIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function timelineIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.timelineIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

function outputIdsFromState(
  state: ChatStoreState,
  itemId: string,
): readonly string[] {
  return state.outputIdsByItemId[itemId] ?? EMPTY_IDS;
}

function isActivityItem(item: ChatItem): boolean {
  return item.kind !== "agent_message" && item.kind !== "reasoning";
}

function buildTimelineIds(
  messages: readonly ChatMessage[],
  items: readonly ChatItem[],
  pendingRequests: readonly ChatPendingRequest[] = [],
  plans: readonly ChatPlan[] = [],
  diffSummaries: readonly ChatDiffSummary[] = [],
): string[] {
  const rows = [
    ...messages.map((message) => ({
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      sequence: message.sequence,
      priority: message.role === "user" ? 0 : 2,
    })),
    ...items.filter(isActivityItem).map((item) => ({
      id: `activity:${item.id}`,
      createdAt: item.createdAt,
      sequence: item.sequence,
      priority: 1,
    })),
    ...pendingRequests.map((request) => ({
      id: `request:${request.id}`,
      createdAt: request.createdAt,
      sequence: request.sequence,
      priority: 1,
    })),
    ...plans.map((plan) => ({
      id: `plan:${plan.id}`,
      createdAt: plan.createdAt,
      sequence: plan.sequence,
      priority: 1,
    })),
    ...diffSummaries.map((diff) => ({
      id: `diff:${diff.id}`,
      createdAt: diff.createdAt,
      sequence: diff.sequence,
      priority: 1,
    })),
  ];
  return rows
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      if (left.sequence !== right.sequence) {
        return left.sequence - right.sequence;
      }
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.id.localeCompare(right.id);
    })
    .map((row) => row.id);
}

function timelineIdsForState(
  state: ChatStoreState,
  conversationId: string,
  messagesById: Record<string, ChatMessage> = state.messagesById,
  itemsById: Record<string, ChatItem> = state.itemsById,
  pendingRequestsById: Record<
    string,
    ChatPendingRequest
  > = state.pendingRequestsById,
  plansById: Record<string, ChatPlan> = state.plansById,
  diffSummariesById: Record<string, ChatDiffSummary> = state.diffSummariesById,
): string[] {
  const messages = messageIdsFromState(state, conversationId)
    .map((messageId) => messagesById[messageId])
    .filter((message): message is ChatMessage => Boolean(message));
  const items = itemIdsFromState(state, conversationId)
    .map((itemId) => itemsById[itemId])
    .filter((item): item is ChatItem => Boolean(item));
  const pendingRequests = pendingRequestIdsFromState(state, conversationId)
    .map((requestId) => pendingRequestsById[requestId])
    .filter((request): request is ChatPendingRequest => Boolean(request));
  const plans = planIdsFromState(state, conversationId)
    .map((planId) => plansById[planId])
    .filter((plan): plan is ChatPlan => Boolean(plan));
  const diffSummaries = diffSummaryIdsFromState(state, conversationId)
    .map((diffId) => diffSummariesById[diffId])
    .filter((diff): diff is ChatDiffSummary => Boolean(diff));
  return buildTimelineIds(
    messages,
    items,
    pendingRequests,
    plans,
    diffSummaries,
  );
}

function denormalizeConversationDetail(
  state: ChatStoreState,
  conversationId: string,
): ChatConversationDetail | null {
  const detailState = state.detailsByConversationId[conversationId];
  const conversation = state.conversationsById[conversationId];
  if (detailState?.status !== "loaded" || !conversation) {
    return null;
  }

  return {
    conversation,
    messages: messageIdsFromState(state, conversationId)
      .map((messageId) => state.messagesById[messageId])
      .filter((message): message is ChatMessage => Boolean(message)),
    turns: turnIdsFromState(state, conversationId)
      .map((turnId) => state.turnsById[turnId])
      .filter((turn): turn is ChatTurn => Boolean(turn)),
    items: itemIdsFromState(state, conversationId)
      .map((itemId) => state.itemsById[itemId])
      .filter((item): item is ChatItem => Boolean(item)),
    plans: planIdsFromState(state, conversationId)
      .map((planId) => state.plansById[planId])
      .filter((plan): plan is ChatPlan => Boolean(plan)),
    diffSummaries: diffSummaryIdsFromState(state, conversationId)
      .map((diffId) => state.diffSummariesById[diffId])
      .filter((diff): diff is ChatDiffSummary => Boolean(diff)),
    contextUsage: state.contextUsageByConversationId[conversationId] ?? null,
    pendingRequests: pendingRequestIdsFromState(state, conversationId)
      .map((requestId) => state.pendingRequestsById[requestId])
      .filter((request): request is ChatPendingRequest => Boolean(request)),
    latestRun: state.latestRunByConversationId[conversationId] ?? null,
  };
}

function denormalizeActivityDetail(
  state: ChatStoreState,
  itemId: string,
): ChatActivityDetail | null {
  const item = state.itemsById[itemId];
  const status = state.activityDetailsByItemId[itemId];
  if (!item || status?.status !== "loaded") {
    return null;
  }
  return {
    item,
    outputs: outputIdsFromState(state, itemId)
      .map((outputId) => state.outputsById[outputId])
      .filter((output): output is ChatItemOutput => Boolean(output)),
  };
}

function mapById<T extends { id: string }>(
  items: readonly T[],
): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function sortedIds<T extends { id: string }>(
  items: readonly T[],
  sorter: (items: readonly T[]) => T[],
): string[] {
  return sorter(items).map((item) => item.id);
}

function loadedDetailState(): ConversationDetailState {
  return {
    status: "loaded",
    error: null,
    needsRefresh: false,
  };
}

function setDetail(
  conversationId: string,
  detail: ChatConversationDetail,
): void {
  const messages = sortMessages(detail.messages);
  const turns = sortTurns(detail.turns ?? []);
  const items = sortItems(detail.items ?? []);
  const pendingRequests = sortPendingRequests(detail.pendingRequests ?? []);
  const plans = sortPlans(detail.plans ?? []);
  const diffSummaries = sortDiffSummaries(detail.diffSummaries ?? []);
  const timelineIds = buildTimelineIds(
    messages,
    items,
    pendingRequests,
    plans,
    diffSummaries,
  );

  useChatStore.setState((state) => {
    const contextUsageByConversationId = {
      ...state.contextUsageByConversationId,
    };
    if (detail.contextUsage) {
      contextUsageByConversationId[conversationId] = detail.contextUsage;
    } else {
      delete contextUsageByConversationId[conversationId];
    }
    return {
      conversationsById: {
        ...state.conversationsById,
        [conversationId]: detail.conversation,
      },
      detailsByConversationId: {
        ...state.detailsByConversationId,
        [conversationId]: loadedDetailState(),
      },
      messageIdsByConversationId: {
        ...state.messageIdsByConversationId,
        [conversationId]: messages.map((message) => message.id),
      },
      messagesById: {
        ...state.messagesById,
        ...mapById(messages),
      },
      turnIdsByConversationId: {
        ...state.turnIdsByConversationId,
        [conversationId]: turns.map((turn) => turn.id),
      },
      turnsById: {
        ...state.turnsById,
        ...mapById(turns),
      },
      itemIdsByConversationId: {
        ...state.itemIdsByConversationId,
        [conversationId]: items.map((item) => item.id),
      },
      itemsById: {
        ...state.itemsById,
        ...mapById(items),
      },
      pendingRequestIdsByConversationId: {
        ...state.pendingRequestIdsByConversationId,
        [conversationId]: pendingRequests.map((request) => request.id),
      },
      pendingRequestsById: {
        ...state.pendingRequestsById,
        ...mapById(pendingRequests),
      },
      planIdsByConversationId: {
        ...state.planIdsByConversationId,
        [conversationId]: plans.map((plan) => plan.id),
      },
      plansById: {
        ...state.plansById,
        ...mapById(plans),
      },
      diffSummaryIdsByConversationId: {
        ...state.diffSummaryIdsByConversationId,
        [conversationId]: diffSummaries.map((diff) => diff.id),
      },
      diffSummariesById: {
        ...state.diffSummariesById,
        ...mapById(diffSummaries),
      },
      contextUsageByConversationId,
      timelineIdsByConversationId: {
        ...state.timelineIdsByConversationId,
        [conversationId]: timelineIds,
      },
      latestRunByConversationId: {
        ...state.latestRunByConversationId,
        [conversationId]: detail.latestRun ?? null,
      },
    };
  });
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

async function loadActivity(
  conversationId: string,
  itemId: string,
): Promise<ChatActivityDetail | null> {
  useChatStore.setState((state) => ({
    activityDetailsByItemId: {
      ...state.activityDetailsByItemId,
      [itemId]: {
        ...(state.activityDetailsByItemId[itemId] ??
          DEFAULT_ACTIVITY_DETAIL_STATE),
        status: "loading",
        error: null,
      },
    },
  }));

  try {
    const detail = await getChatActivity(conversationId, itemId);
    useChatStore.setState((state) => {
      const outputsById = {
        ...state.outputsById,
        ...mapById(detail.outputs),
      };
      const itemIds = itemIdsFromState(state, conversationId);
      const itemsById = {
        ...state.itemsById,
        [detail.item.id]: detail.item,
      };
      const itemIdsByConversationId = {
        ...state.itemIdsByConversationId,
        [conversationId]: upsertSortedEntity(
          itemIds,
          itemsById,
          detail.item,
          sortItems,
        ),
      };
      const nextState = {
        ...state,
        itemsById,
        itemIdsByConversationId,
      };
      return {
        itemsById,
        itemIdsByConversationId,
        timelineIdsByConversationId: {
          ...state.timelineIdsByConversationId,
          [conversationId]: timelineIdsForState(
            nextState,
            conversationId,
            state.messagesById,
            itemsById,
          ),
        },
        outputIdsByItemId: {
          ...state.outputIdsByItemId,
          [itemId]: sortedIds(detail.outputs, sortOutputs),
        },
        outputsById,
        activityDetailsByItemId: {
          ...state.activityDetailsByItemId,
          [itemId]: {
            status: "loaded",
            error: null,
          },
        },
      };
    });
    return detail;
  } catch (error) {
    useChatStore.setState((state) => ({
      activityDetailsByItemId: {
        ...state.activityDetailsByItemId,
        [itemId]: {
          status: "error",
          error:
            error instanceof Error ? error.message : "Failed to load activity",
        },
      },
    }));
    return null;
  }
}

function upsertSortedEntity<T extends { id: string }>(
  ids: readonly string[],
  byId: Record<string, T>,
  entity: T,
  sorter: (items: readonly T[]) => T[],
): string[] {
  const nextById = { ...byId, [entity.id]: entity };
  const nextIds = ids.includes(entity.id) ? [...ids] : [...ids, entity.id];
  return sortedIds(
    nextIds
      .map((id) => nextById[id])
      .filter((item): item is T => Boolean(item)),
    sorter,
  );
}

function isConversationLoaded(
  state: ChatStoreState,
  conversationId: string,
): boolean {
  return state.detailsByConversationId[conversationId]?.status === "loaded";
}

function hasStreamingAssistantMessage(
  state: ChatStoreState,
  conversationId: string,
): boolean {
  return messageIdsFromState(state, conversationId).some((messageId) => {
    const message = state.messagesById[messageId];
    return message?.role === "assistant" && message.status === "streaming";
  });
}

export function selectChatDetailState(
  state: ChatStoreState,
  conversationId: string,
): ConversationDetailState {
  return state.detailsByConversationId[conversationId] ?? DEFAULT_DETAIL_STATE;
}

export function selectChatConversation(
  state: ChatStoreState,
  conversationId: string,
): ChatConversationSummary | null {
  return state.conversationsById[conversationId] ?? null;
}

export function selectChatMessageIds(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return messageIdsFromState(state, conversationId);
}

export function selectChatTimelineIds(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return timelineIdsFromState(state, conversationId);
}

export function selectChatMessage(
  state: ChatStoreState,
  messageId: string,
): ChatMessage | null {
  return state.messagesById[messageId] ?? null;
}

export function selectChatItem(
  state: ChatStoreState,
  itemId: string,
): ChatItem | null {
  return state.itemsById[itemId] ?? null;
}

export function selectChatItemOutputIds(
  state: ChatStoreState,
  itemId: string,
): readonly string[] {
  return outputIdsFromState(state, itemId);
}

export function selectChatItemOutput(
  state: ChatStoreState,
  outputId: string,
): ChatItemOutput | null {
  return state.outputsById[outputId] ?? null;
}

export function selectChatPendingRequest(
  state: ChatStoreState,
  requestId: string,
): ChatPendingRequest | null {
  return state.pendingRequestsById[requestId] ?? null;
}

export function selectChatPlan(
  state: ChatStoreState,
  planId: string,
): ChatPlan | null {
  return state.plansById[planId] ?? null;
}

export function selectChatDiffSummary(
  state: ChatStoreState,
  diffId: string,
): ChatDiffSummary | null {
  return state.diffSummariesById[diffId] ?? null;
}

export function selectChatContextUsage(
  state: ChatStoreState,
  conversationId: string,
): ChatContextUsage | null {
  return state.contextUsageByConversationId[conversationId] ?? null;
}

export function selectChatActivePendingRequestIds(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  const ids = pendingRequestIdsFromState(state, conversationId).filter((id) => {
    const request = state.pendingRequestsById[id];
    return request?.status === "pending" || request?.status === "resolving";
  });
  return ids.length > 0 ? ids : EMPTY_IDS;
}

export function selectChatActivityDetailState(
  state: ChatStoreState,
  itemId: string,
): ActivityDetailState {
  return state.activityDetailsByItemId[itemId] ?? DEFAULT_ACTIVITY_DETAIL_STATE;
}

export function selectChatLatestRun(
  state: ChatStoreState,
  conversationId: string,
): ChatRun | null {
  return state.latestRunByConversationId[conversationId] ?? null;
}

export function selectChatRuntime(
  state: ChatStoreState,
  conversationId: string,
): ChatRuntimeStatus | null {
  return state.runtimesByConversationId[conversationId] ?? null;
}

export function selectChatComposerMessages(): readonly never[] {
  return EMPTY_THREAD_MESSAGES;
}

export function selectChatHeaderSlice(
  state: ChatStoreState,
  conversationId: string,
): {
  conversation: ChatConversationSummary | null;
  latestRun: ChatRun | null;
  runtime: ChatRuntimeStatus | null;
  detailError: string | null;
  modelOptionsError: string | null;
  hasStreamingMessage: boolean;
} {
  const detailState = selectChatDetailState(state, conversationId);
  return {
    conversation: selectChatConversation(state, conversationId),
    latestRun: selectChatLatestRun(state, conversationId),
    runtime: selectChatRuntime(state, conversationId),
    detailError: detailState.error,
    modelOptionsError: state.modelOptionsError,
    hasStreamingMessage: hasStreamingAssistantMessage(state, conversationId),
  };
}

export function selectChatModelSlice(
  state: ChatStoreState,
  conversationId: string,
): {
  conversation: ChatConversationSummary | null;
  modelOptions: ChatModelOption[];
  modelOptionsStatus: ChatStoreState["modelOptionsStatus"];
  modelOptionsError: string | null;
  runtime: ChatRuntimeStatus | null;
  hasStreamingMessage: boolean;
} {
  return {
    conversation: selectChatConversation(state, conversationId),
    modelOptions: state.modelOptions,
    modelOptionsStatus: state.modelOptionsStatus,
    modelOptionsError: state.modelOptionsError,
    runtime: selectChatRuntime(state, conversationId),
    hasStreamingMessage: hasStreamingAssistantMessage(state, conversationId),
  };
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  appServerStatus: null,
  conversationsById: {},
  runtimesByConversationId: {},
  threadStreamsByConversationId: {},
  detailsByConversationId: {},
  messageIdsByConversationId: {},
  messagesById: {},
  turnIdsByConversationId: {},
  turnsById: {},
  itemIdsByConversationId: {},
  itemsById: {},
  timelineIdsByConversationId: {},
  outputIdsByItemId: {},
  outputsById: {},
  activityDetailsByItemId: {},
  planIdsByConversationId: {},
  plansById: {},
  diffSummaryIdsByConversationId: {},
  diffSummariesById: {},
  contextUsageByConversationId: {},
  pendingRequestIdsByConversationId: {},
  pendingRequestsById: {},
  pendingRequestSummariesById: {},
  latestRunByConversationId: {},
  modelOptions: [],
  modelOptionsStatus: "idle",
  modelOptionsError: null,
  async ensureConversationLoaded(conversationId) {
    const current = get().detailsByConversationId[conversationId];
    if (current?.status === "loaded" && !current.needsRefresh) {
      return denormalizeConversationDetail(get(), conversationId);
    }
    if (current?.status === "loading") {
      return denormalizeConversationDetail(get(), conversationId);
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
  async ensureActivityLoaded(conversationId, itemId) {
    const current = get().activityDetailsByItemId[itemId];
    if (current?.status === "loaded") {
      return denormalizeActivityDetail(get(), itemId);
    }
    if (current?.status === "loading") {
      return denormalizeActivityDetail(get(), itemId);
    }
    return loadActivity(conversationId, itemId);
  },
  async sendMessage(conversationId, text) {
    await sendChatMessage(conversationId, text);
  },
  async interruptRun(conversationId) {
    await interruptChat(conversationId);
  },
  async resolvePendingRequest(conversationId, requestId, decision, value) {
    await resolveChatPendingRequest(conversationId, requestId, {
      decision,
      ...(value === undefined ? {} : { value }),
    });
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
      const existingMessageIds =
        state.messageIdsByConversationId[conversationId] ?? [];
      const existingTurnIds =
        state.turnIdsByConversationId[conversationId] ?? [];
      const existingItemIds =
        state.itemIdsByConversationId[conversationId] ?? [];
      const existingPendingRequestIds =
        state.pendingRequestIdsByConversationId[conversationId] ?? [];
      const existingPlanIds =
        state.planIdsByConversationId[conversationId] ?? [];
      const existingDiffIds =
        state.diffSummaryIdsByConversationId[conversationId] ?? [];
      const detailsByConversationId = { ...state.detailsByConversationId };
      const messageIdsByConversationId = {
        ...state.messageIdsByConversationId,
      };
      const messagesById = { ...state.messagesById };
      const turnIdsByConversationId = { ...state.turnIdsByConversationId };
      const turnsById = { ...state.turnsById };
      const itemIdsByConversationId = { ...state.itemIdsByConversationId };
      const itemsById = { ...state.itemsById };
      const timelineIdsByConversationId = {
        ...state.timelineIdsByConversationId,
      };
      const outputIdsByItemId = { ...state.outputIdsByItemId };
      const outputsById = { ...state.outputsById };
      const activityDetailsByItemId = { ...state.activityDetailsByItemId };
      const pendingRequestIdsByConversationId = {
        ...state.pendingRequestIdsByConversationId,
      };
      const pendingRequestsById = { ...state.pendingRequestsById };
      const planIdsByConversationId = { ...state.planIdsByConversationId };
      const plansById = { ...state.plansById };
      const diffSummaryIdsByConversationId = {
        ...state.diffSummaryIdsByConversationId,
      };
      const diffSummariesById = { ...state.diffSummariesById };
      const contextUsageByConversationId = {
        ...state.contextUsageByConversationId,
      };
      const latestRunByConversationId = { ...state.latestRunByConversationId };
      for (const messageId of existingMessageIds) {
        delete messagesById[messageId];
      }
      for (const turnId of existingTurnIds) {
        delete turnsById[turnId];
      }
      for (const itemId of existingItemIds) {
        for (const outputId of outputIdsByItemId[itemId] ?? []) {
          delete outputsById[outputId];
        }
        delete outputIdsByItemId[itemId];
        delete activityDetailsByItemId[itemId];
        delete itemsById[itemId];
      }
      for (const requestId of existingPendingRequestIds) {
        delete pendingRequestsById[requestId];
      }
      for (const planId of existingPlanIds) {
        delete plansById[planId];
      }
      for (const diffId of existingDiffIds) {
        delete diffSummariesById[diffId];
      }
      delete detailsByConversationId[conversationId];
      delete messageIdsByConversationId[conversationId];
      delete turnIdsByConversationId[conversationId];
      delete itemIdsByConversationId[conversationId];
      delete pendingRequestIdsByConversationId[conversationId];
      delete planIdsByConversationId[conversationId];
      delete diffSummaryIdsByConversationId[conversationId];
      delete contextUsageByConversationId[conversationId];
      delete timelineIdsByConversationId[conversationId];
      delete latestRunByConversationId[conversationId];
      return {
        detailsByConversationId,
        messageIdsByConversationId,
        messagesById,
        turnIdsByConversationId,
        turnsById,
        itemIdsByConversationId,
        itemsById,
        timelineIdsByConversationId,
        outputIdsByItemId,
        outputsById,
        activityDetailsByItemId,
        planIdsByConversationId,
        plansById,
        diffSummaryIdsByConversationId,
        diffSummariesById,
        contextUsageByConversationId,
        pendingRequestIdsByConversationId,
        pendingRequestsById,
        latestRunByConversationId,
      };
    });
  },
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let queuedChatEvents: ChatBatchEvent[] = [];
let queuedChatFrame: number | null = null;

function handleConversationEvent(
  data:
    | SseEventData<"chat_conversation_created">
    | SseEventData<"chat_conversation_updated">,
): void {
  useChatStore.setState((state) => ({
    conversationsById: {
      ...state.conversationsById,
      [data.conversation.id]: data.conversation,
    },
  }));
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

function handleAppServerEvent(
  data: SseEventData<"chat_app_server_updated">,
): void {
  useChatStore.setState({
    appServerStatus: data.app_server,
  });
}

function handleThreadStreamEvent(
  data: SseEventData<"chat_thread_stream_updated">,
): void {
  useChatStore.setState((state) => ({
    threadStreamsByConversationId: {
      ...state.threadStreamsByConversationId,
      [data.stream.conversationId]: data.stream,
    },
  }));
}

function enqueueChatEvent(event: ChatBatchEvent): void {
  queuedChatEvents.push(event);
  if (queuedChatFrame !== null) {
    return;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    queuedChatFrame = window.requestAnimationFrame(flushQueuedChatEvents);
    return;
  }
  queuedChatFrame = -1;
  queueMicrotask(flushQueuedChatEvents);
}

function markConversationDirtyInBatch(
  state: ChatStoreState,
  conversationId: string,
): ChatStoreState {
  const current =
    state.detailsByConversationId[conversationId] ?? DEFAULT_DETAIL_STATE;
  return {
    ...state,
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: {
        ...current,
        needsRefresh: true,
      },
    },
  };
}

function applyMessageUpdated(
  state: ChatStoreState,
  conversationId: string,
  message: ChatMessage,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const currentIds = messageIdsFromState(state, conversationId);
  const messagesById = {
    ...state.messagesById,
    [message.id]: message,
  };
  const messageIdsByConversationId = {
    ...state.messageIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      currentIds,
      messagesById,
      message,
      sortMessages,
    ),
  };
  const nextState = {
    ...state,
    messagesById,
    messageIdsByConversationId,
  };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...state.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(
        nextState,
        conversationId,
        messagesById,
        state.itemsById,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyMessageDelta(
  state: ChatStoreState,
  data: SseEventData<"chat_message_delta">,
): ChatStoreState {
  if (!isConversationLoaded(state, data.conversation_id)) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  const message = state.messagesById[data.message_id];
  if (!message) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  return {
    ...state,
    messagesById: {
      ...state.messagesById,
      [data.message_id]: {
        ...message,
        contentText: `${message.contentText}${data.delta}`,
      },
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [data.conversation_id]: loadedDetailState(),
    },
  };
}

function applyRunUpdated(
  state: ChatStoreState,
  conversationId: string,
  run: ChatRun,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const existing = state.latestRunByConversationId[conversationId];
  const runs = [existing].filter(
    (candidate): candidate is ChatRun =>
      candidate !== null && candidate.id !== run.id,
  );
  const latestRun = sortRuns([...runs, run])[0] ?? null;
  return {
    ...state,
    latestRunByConversationId: {
      ...state.latestRunByConversationId,
      [conversationId]: latestRun,
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyTurnUpdated(
  state: ChatStoreState,
  conversationId: string,
  turn: ChatTurn,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const currentIds = turnIdsFromState(state, conversationId);
  const turnsById = {
    ...state.turnsById,
    [turn.id]: turn,
  };
  return {
    ...state,
    turnsById,
    turnIdsByConversationId: {
      ...state.turnIdsByConversationId,
      [conversationId]: upsertSortedEntity(
        currentIds,
        turnsById,
        turn,
        sortTurns,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyItemUpdated(
  state: ChatStoreState,
  conversationId: string,
  item: ChatItem,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const currentIds = itemIdsFromState(state, conversationId);
  const itemsById = {
    ...state.itemsById,
    [item.id]: item,
  };
  const itemIdsByConversationId = {
    ...state.itemIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      currentIds,
      itemsById,
      item,
      sortItems,
    ),
  };
  const nextState = {
    ...state,
    itemsById,
    itemIdsByConversationId,
  };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...state.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(
        nextState,
        conversationId,
        state.messagesById,
        itemsById,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyPendingRequestUpdated(
  state: ChatStoreState,
  request: ChatPendingRequest,
): ChatStoreState {
  const conversationId = request.conversationId;
  const pendingRequestSummariesById = {
    ...state.pendingRequestSummariesById,
    [request.id]: {
      id: request.id,
      conversationId,
      kind: request.kind,
      status: request.status,
      method: request.method,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    },
  };
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(
      {
        ...state,
        pendingRequestSummariesById,
      },
      conversationId,
    );
  }
  const currentIds = pendingRequestIdsFromState(state, conversationId);
  const pendingRequestsById = {
    ...state.pendingRequestsById,
    [request.id]: request,
  };
  const pendingRequestIdsByConversationId = {
    ...state.pendingRequestIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      currentIds,
      pendingRequestsById,
      request,
      sortPendingRequests,
    ),
  };
  const nextState = {
    ...state,
    pendingRequestSummariesById,
    pendingRequestsById,
    pendingRequestIdsByConversationId,
  };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...state.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(
        nextState,
        conversationId,
        state.messagesById,
        state.itemsById,
        pendingRequestsById,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyPlanUpdated(
  state: ChatStoreState,
  conversationId: string,
  plan: ChatPlan,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const currentIds = planIdsFromState(state, conversationId);
  const plansById = {
    ...state.plansById,
    [plan.id]: plan,
  };
  const planIdsByConversationId = {
    ...state.planIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      currentIds,
      plansById,
      plan,
      sortPlans,
    ),
  };
  const nextState = {
    ...state,
    plansById,
    planIdsByConversationId,
  };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...state.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(
        nextState,
        conversationId,
        state.messagesById,
        state.itemsById,
        state.pendingRequestsById,
        plansById,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyDiffUpdated(
  state: ChatStoreState,
  conversationId: string,
  diff: ChatDiffSummary,
): ChatStoreState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const currentIds = diffSummaryIdsFromState(state, conversationId);
  const diffSummariesById = {
    ...state.diffSummariesById,
    [diff.id]: diff,
  };
  const diffSummaryIdsByConversationId = {
    ...state.diffSummaryIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      currentIds,
      diffSummariesById,
      diff,
      sortDiffSummaries,
    ),
  };
  const nextState = {
    ...state,
    diffSummariesById,
    diffSummaryIdsByConversationId,
  };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...state.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(
        nextState,
        conversationId,
        state.messagesById,
        state.itemsById,
        state.pendingRequestsById,
        state.plansById,
        diffSummariesById,
      ),
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyContextUsageUpdated(
  state: ChatStoreState,
  usage: ChatContextUsage,
): ChatStoreState {
  const nextState = {
    ...state,
    contextUsageByConversationId: {
      ...state.contextUsageByConversationId,
      [usage.conversationId]: usage,
    },
  };
  if (!isConversationLoaded(state, usage.conversationId)) {
    return markConversationDirtyInBatch(nextState, usage.conversationId);
  }
  return {
    ...nextState,
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [usage.conversationId]: loadedDetailState(),
    },
  };
}

function applyActivityDelta(
  state: ChatStoreState,
  data: SseEventData<"chat_activity_delta">,
): ChatStoreState {
  if (!isConversationLoaded(state, data.conversation_id)) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  if (!state.itemsById[data.item_id]) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  const output = data.output;
  const currentIds = outputIdsFromState(state, data.item_id);
  const outputsById = {
    ...state.outputsById,
    [output.id]: output,
  };
  return {
    ...state,
    outputsById,
    outputIdsByItemId: {
      ...state.outputIdsByItemId,
      [data.item_id]: upsertSortedEntity(
        currentIds,
        outputsById,
        output,
        sortOutputs,
      ),
    },
    activityDetailsByItemId: {
      ...state.activityDetailsByItemId,
      [data.item_id]: {
        status: "loaded",
        error: null,
      },
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [data.conversation_id]: loadedDetailState(),
    },
  };
}

function applyQueuedChatEvents(
  state: ChatStoreState,
  events: readonly ChatBatchEvent[],
): ChatStoreState {
  return events.reduce((nextState, event) => {
    switch (event.type) {
      case "message_delta":
        return applyMessageDelta(nextState, event.data);
      case "message_updated":
        return applyMessageUpdated(
          nextState,
          event.data.conversation_id,
          event.data.message,
        );
      case "run_updated":
        return applyRunUpdated(
          nextState,
          event.data.conversation_id,
          event.data.run,
        );
      case "turn_updated":
        return applyTurnUpdated(
          nextState,
          event.data.conversation_id,
          event.data.turn,
        );
      case "item_updated":
        return applyItemUpdated(
          nextState,
          event.data.conversation_id,
          event.data.item,
        );
      case "activity_delta":
        return applyActivityDelta(nextState, event.data);
      case "activity_updated":
        return applyItemUpdated(
          nextState,
          event.data.conversation_id,
          event.data.item,
        );
      case "pending_request_updated":
        return applyPendingRequestUpdated(nextState, event.data.request);
      case "plan_updated":
        return applyPlanUpdated(
          nextState,
          event.data.conversation_id,
          event.data.plan,
        );
      case "diff_updated":
        return applyDiffUpdated(
          nextState,
          event.data.conversation_id,
          event.data.diff,
        );
      case "context_usage_updated":
        return applyContextUsageUpdated(nextState, event.data.usage);
    }
  }, state);
}

function flushQueuedChatEvents(): void {
  const events = queuedChatEvents;
  queuedChatEvents = [];
  queuedChatFrame = null;
  if (events.length === 0) {
    return;
  }
  useChatStore.setState((state) => applyQueuedChatEvents(state, events));
}

function handleMessageUpdated(
  data: SseEventData<"chat_message_updated">,
): void {
  enqueueChatEvent({ type: "message_updated", data });
}

function handleRunUpdated(data: SseEventData<"chat_run_updated">): void {
  enqueueChatEvent({ type: "run_updated", data });
}

function handleTurnUpdated(data: SseEventData<"chat_turn_updated">): void {
  enqueueChatEvent({ type: "turn_updated", data });
}

function handleItemUpdated(data: SseEventData<"chat_item_updated">): void {
  enqueueChatEvent({ type: "item_updated", data });
}

function handleActivityDelta(data: SseEventData<"chat_activity_delta">): void {
  enqueueChatEvent({ type: "activity_delta", data });
}

function handleActivityUpdated(
  data: SseEventData<"chat_activity_updated">,
): void {
  enqueueChatEvent({ type: "activity_updated", data });
}

function handleMessageDelta(data: SseEventData<"chat_message_delta">): void {
  enqueueChatEvent({ type: "message_delta", data });
}

function handlePendingRequestUpdated(
  data:
    | SseEventData<"chat_pending_request_created">
    | SseEventData<"chat_pending_request_updated">
    | SseEventData<"chat_pending_request_resolved">,
): void {
  enqueueChatEvent({ type: "pending_request_updated", data });
}

function handlePlanUpdated(data: SseEventData<"chat_plan_updated">): void {
  enqueueChatEvent({ type: "plan_updated", data });
}

function handleDiffUpdated(data: SseEventData<"chat_diff_updated">): void {
  enqueueChatEvent({ type: "diff_updated", data });
}

function handleContextUsageUpdated(
  data: SseEventData<"chat_context_usage_updated">,
): void {
  enqueueChatEvent({ type: "context_usage_updated", data });
}

export function initializeChatStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      flushQueuedChatEvents();
      const nextConversations = indexConversations(data.chat_conversations);
      const nextPendingRequestSummaries = indexPendingRequestSummaries(
        data.chat_pending_requests,
      );
      useChatStore.setState((state) => {
        const conversationIds = new Set(Object.keys(nextConversations));
        const messageIdsByConversationId = Object.fromEntries(
          Object.entries(state.messageIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const turnIdsByConversationId = Object.fromEntries(
          Object.entries(state.turnIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const itemIdsByConversationId = Object.fromEntries(
          Object.entries(state.itemIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const timelineIdsByConversationId = Object.fromEntries(
          Object.entries(state.timelineIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const messageIds = new Set(
          Object.values(messageIdsByConversationId).flat(),
        );
        const turnIds = new Set(Object.values(turnIdsByConversationId).flat());
        const itemIds = new Set(Object.values(itemIdsByConversationId).flat());
        const pendingRequestIdsByConversationId = Object.fromEntries(
          Object.entries(state.pendingRequestIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const pendingRequestIds = new Set(
          Object.values(pendingRequestIdsByConversationId).flat(),
        );
        const planIdsByConversationId = Object.fromEntries(
          Object.entries(state.planIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const planIds = new Set(Object.values(planIdsByConversationId).flat());
        const diffSummaryIdsByConversationId = Object.fromEntries(
          Object.entries(state.diffSummaryIdsByConversationId).filter(
            ([conversationId]) => conversationIds.has(conversationId),
          ),
        );
        const diffIds = new Set(
          Object.values(diffSummaryIdsByConversationId).flat(),
        );
        const outputIdsByItemId = Object.fromEntries(
          Object.entries(state.outputIdsByItemId).filter(([itemId]) =>
            itemIds.has(itemId),
          ),
        );
        const outputIds = new Set(Object.values(outputIdsByItemId).flat());

        return {
          appServerStatus: data.chat_app_server ?? null,
          conversationsById: nextConversations,
          runtimesByConversationId: indexRuntimes(data.chat_runtimes),
          threadStreamsByConversationId: indexThreadStreams(
            data.chat_thread_streams,
          ),
          detailsByConversationId: Object.fromEntries(
            Object.entries(state.detailsByConversationId).filter(
              ([conversationId]) => conversationIds.has(conversationId),
            ),
          ),
          messageIdsByConversationId,
          messagesById: Object.fromEntries(
            Object.entries(state.messagesById).filter(([messageId]) =>
              messageIds.has(messageId),
            ),
          ),
          turnIdsByConversationId,
          turnsById: Object.fromEntries(
            Object.entries(state.turnsById).filter(([turnId]) =>
              turnIds.has(turnId),
            ),
          ),
          itemIdsByConversationId,
          itemsById: Object.fromEntries(
            Object.entries(state.itemsById).filter(([itemId]) =>
              itemIds.has(itemId),
            ),
          ),
          timelineIdsByConversationId,
          outputIdsByItemId,
          outputsById: Object.fromEntries(
            Object.entries(state.outputsById).filter(([outputId]) =>
              outputIds.has(outputId),
            ),
          ),
          activityDetailsByItemId: Object.fromEntries(
            Object.entries(state.activityDetailsByItemId).filter(([itemId]) =>
              itemIds.has(itemId),
            ),
          ),
          pendingRequestIdsByConversationId,
          pendingRequestsById: Object.fromEntries(
            Object.entries(state.pendingRequestsById).filter(([requestId]) =>
              pendingRequestIds.has(requestId),
            ),
          ),
          pendingRequestSummariesById: nextPendingRequestSummaries,
          planIdsByConversationId,
          plansById: Object.fromEntries(
            Object.entries(state.plansById).filter(([planId]) =>
              planIds.has(planId),
            ),
          ),
          diffSummaryIdsByConversationId,
          diffSummariesById: Object.fromEntries(
            Object.entries(state.diffSummariesById).filter(([diffId]) =>
              diffIds.has(diffId),
            ),
          ),
          contextUsageByConversationId: Object.fromEntries(
            (data.chat_context_usage ?? []).map((usage) => [
              usage.conversationId,
              usage,
            ]),
          ),
          latestRunByConversationId: Object.fromEntries(
            Object.entries(state.latestRunByConversationId).filter(
              ([conversationId]) => conversationIds.has(conversationId),
            ),
          ),
        };
      });
    }),
    events.on("chat_conversation_created", handleConversationEvent),
    events.on("chat_conversation_updated", handleConversationEvent),
    events.on("chat_runtime_updated", handleRuntimeEvent),
    events.on("chat_app_server_updated", handleAppServerEvent),
    events.on("chat_thread_stream_updated", handleThreadStreamEvent),
    events.on("chat_message_updated", handleMessageUpdated),
    events.on("chat_message_delta", handleMessageDelta),
    events.on("chat_run_updated", handleRunUpdated),
    events.on("chat_turn_updated", handleTurnUpdated),
    events.on("chat_item_updated", handleItemUpdated),
    events.on("chat_activity_delta", handleActivityDelta),
    events.on("chat_activity_updated", handleActivityUpdated),
    events.on("chat_pending_request_created", handlePendingRequestUpdated),
    events.on("chat_pending_request_updated", handlePendingRequestUpdated),
    events.on("chat_pending_request_resolved", handlePendingRequestUpdated),
    events.on("chat_plan_updated", handlePlanUpdated),
    events.on("chat_diff_updated", handleDiffUpdated),
    events.on("chat_context_usage_updated", handleContextUsageUpdated),
  ];
}

export function flushChatStoreSseBatchForTests(): void {
  flushQueuedChatEvents();
}

export function resetChatStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  queuedChatEvents = [];
  if (
    queuedChatFrame !== null &&
    queuedChatFrame > 0 &&
    typeof window !== "undefined" &&
    typeof window.cancelAnimationFrame === "function"
  ) {
    window.cancelAnimationFrame(queuedChatFrame);
  }
  queuedChatFrame = null;
  useChatStore.setState({
    appServerStatus: null,
    conversationsById: {},
    runtimesByConversationId: {},
    threadStreamsByConversationId: {},
    detailsByConversationId: {},
    messageIdsByConversationId: {},
    messagesById: {},
    turnIdsByConversationId: {},
    turnsById: {},
    itemIdsByConversationId: {},
    itemsById: {},
    timelineIdsByConversationId: {},
    outputIdsByItemId: {},
    outputsById: {},
    activityDetailsByItemId: {},
    planIdsByConversationId: {},
    plansById: {},
    diffSummaryIdsByConversationId: {},
    diffSummariesById: {},
    contextUsageByConversationId: {},
    pendingRequestIdsByConversationId: {},
    pendingRequestsById: {},
    pendingRequestSummariesById: {},
    latestRunByConversationId: {},
    modelOptions: [],
    modelOptionsStatus: "idle",
    modelOptionsError: null,
  });
}
