import { create } from "zustand";
import {
  applyQueuedChatEvents,
  applyReconciliationUpdated,
  type ChatBatchEvent,
} from "@/lib/chat/appliers";
import {
  sortDiffSummaries,
  sortItems,
  sortMessages,
  sortOutputs,
  sortPendingRequests,
  sortPlans,
  sortTurns,
  upsertSortedEntity,
} from "@/lib/chat/helpers";
import type {
  ActivityDetailState,
  ChatViewModelState,
  ConversationDetailState,
} from "@/lib/chat/model";
import {
  buildTimelineIds,
  deriveChatWorkGroupSlice,
  timelineIdsForState,
} from "@/lib/chat/timeline";
import {
  archiveChat,
  deleteChat,
  getChat,
  getChatActivity,
  interruptChat,
  listChatModels,
  patchChatSettings,
  resolveChatPendingRequest,
  sendChatMessage,
  unarchiveChat,
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
  ChatReconciliation,
  ChatRun,
  ChatRuntimeStatus,
  ChatThreadStreamStatus,
  ChatTurn,
} from "@/lib/types";

type ChatStoreState = ChatViewModelState & {
  appServerStatus: ChatAppServerStatus | null;
  conversationsById: Record<string, ChatConversationSummary>;
  runtimesByConversationId: Record<string, ChatRuntimeStatus>;
  threadStreamsByConversationId: Record<string, ChatThreadStreamStatus>;
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
  sendMessage: (
    conversationId: string,
    text: string,
    worktreeId?: string,
  ) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  unarchiveConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
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

function indexReconciliations(
  reconciliations: readonly ChatReconciliation[] = [],
): Record<string, ChatReconciliation> {
  return Object.fromEntries(
    reconciliations.map((reconciliation) => [
      reconciliation.conversationId,
      reconciliation,
    ]),
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

function mergeConversationIntoOpenTabs(
  conversation: ChatConversationSummary,
): void {
  useTabStore
    .getState()
    .updateAgentChatTitle(conversation.id, conversation.title);
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
    latestReconciliation:
      state.reconciliationsByConversationId[conversationId] ?? null,
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
    turns,
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
    const reconciliationsByConversationId = {
      ...state.reconciliationsByConversationId,
    };
    if (detail.latestReconciliation) {
      reconciliationsByConversationId[conversationId] =
        detail.latestReconciliation;
    } else {
      delete reconciliationsByConversationId[conversationId];
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
      reconciliationsByConversationId,
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

export function selectChatWorkGroupSlice(
  state: ChatStoreState,
  conversationId: string,
  turnId: string,
  segmentKey?: string,
) {
  return deriveChatWorkGroupSlice(state, conversationId, turnId, segmentKey);
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

export function selectChatReconciliation(
  state: ChatStoreState,
  conversationId: string,
): ChatReconciliation | null {
  return state.reconciliationsByConversationId[conversationId] ?? null;
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
  reconciliation: ChatReconciliation | null;
  detailError: string | null;
  modelOptionsError: string | null;
  hasStreamingMessage: boolean;
} {
  const detailState = selectChatDetailState(state, conversationId);
  return {
    conversation: selectChatConversation(state, conversationId),
    latestRun: selectChatLatestRun(state, conversationId),
    runtime: selectChatRuntime(state, conversationId),
    reconciliation: selectChatReconciliation(state, conversationId),
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
  reconciliation: ChatReconciliation | null;
  hasStreamingMessage: boolean;
} {
  return {
    conversation: selectChatConversation(state, conversationId),
    modelOptions: state.modelOptions,
    modelOptionsStatus: state.modelOptionsStatus,
    modelOptionsError: state.modelOptionsError,
    runtime: selectChatRuntime(state, conversationId),
    reconciliation: selectChatReconciliation(state, conversationId),
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
  reconciliationsByConversationId: {},
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
  async sendMessage(conversationId, text, worktreeId) {
    await sendChatMessage(conversationId, text, worktreeId);
  },
  async archiveConversation(conversationId) {
    const summary = await archiveChat(conversationId);
    handleConversationEvent({
      sessionId: summary.sessionId,
      conversation: summary,
    });
  },
  async unarchiveConversation(conversationId) {
    const summary = await unarchiveChat(conversationId);
    handleConversationEvent({
      sessionId: summary.sessionId,
      conversation: summary,
    });
  },
  async deleteConversation(conversationId) {
    await deleteChat(conversationId);
    removeConversationFromStore(conversationId);
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
      sessionId: summary.sessionId,
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
      const reconciliationsByConversationId = {
        ...state.reconciliationsByConversationId,
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
      delete reconciliationsByConversationId[conversationId];
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
        reconciliationsByConversationId,
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

function removeConversationFromStore(conversationId: string): void {
  useChatStore.setState((state) => {
    const messageIds = state.messageIdsByConversationId[conversationId] ?? [];
    const turnIds = state.turnIdsByConversationId[conversationId] ?? [];
    const itemIds = state.itemIdsByConversationId[conversationId] ?? [];
    const pendingRequestIds =
      state.pendingRequestIdsByConversationId[conversationId] ?? [];
    const planIds = state.planIdsByConversationId[conversationId] ?? [];
    const diffIds = state.diffSummaryIdsByConversationId[conversationId] ?? [];

    const conversationsById = { ...state.conversationsById };
    const runtimesByConversationId = { ...state.runtimesByConversationId };
    const threadStreamsByConversationId = {
      ...state.threadStreamsByConversationId,
    };
    const detailsByConversationId = { ...state.detailsByConversationId };
    const messageIdsByConversationId = {
      ...state.messageIdsByConversationId,
    };
    const messagesById = { ...state.messagesById };
    const turnIdsByConversationId = { ...state.turnIdsByConversationId };
    const turnsById = { ...state.turnsById };
    const itemIdsByConversationId = { ...state.itemIdsByConversationId };
    const itemsById = { ...state.itemsById };
    const outputIdsByItemId = { ...state.outputIdsByItemId };
    const outputsById = { ...state.outputsById };
    const activityDetailsByItemId = { ...state.activityDetailsByItemId };
    const timelineIdsByConversationId = {
      ...state.timelineIdsByConversationId,
    };
    const pendingRequestIdsByConversationId = {
      ...state.pendingRequestIdsByConversationId,
    };
    const pendingRequestsById = { ...state.pendingRequestsById };
    const pendingRequestSummariesById = {
      ...state.pendingRequestSummariesById,
    };
    const planIdsByConversationId = { ...state.planIdsByConversationId };
    const plansById = { ...state.plansById };
    const diffSummaryIdsByConversationId = {
      ...state.diffSummaryIdsByConversationId,
    };
    const diffSummariesById = { ...state.diffSummariesById };
    const contextUsageByConversationId = {
      ...state.contextUsageByConversationId,
    };
    const reconciliationsByConversationId = {
      ...state.reconciliationsByConversationId,
    };
    const latestRunByConversationId = { ...state.latestRunByConversationId };

    delete conversationsById[conversationId];
    delete runtimesByConversationId[conversationId];
    delete threadStreamsByConversationId[conversationId];
    delete detailsByConversationId[conversationId];
    delete messageIdsByConversationId[conversationId];
    delete turnIdsByConversationId[conversationId];
    delete itemIdsByConversationId[conversationId];
    delete timelineIdsByConversationId[conversationId];
    delete pendingRequestIdsByConversationId[conversationId];
    delete planIdsByConversationId[conversationId];
    delete diffSummaryIdsByConversationId[conversationId];
    delete contextUsageByConversationId[conversationId];
    delete reconciliationsByConversationId[conversationId];
    delete latestRunByConversationId[conversationId];

    for (const id of messageIds) delete messagesById[id];
    for (const id of turnIds) delete turnsById[id];
    for (const id of itemIds) {
      for (const outputId of outputIdsByItemId[id] ?? []) {
        delete outputsById[outputId];
      }
      delete outputIdsByItemId[id];
      delete activityDetailsByItemId[id];
      delete itemsById[id];
    }
    for (const id of pendingRequestIds) {
      delete pendingRequestsById[id];
      delete pendingRequestSummariesById[id];
    }
    for (const [id, summary] of Object.entries(pendingRequestSummariesById)) {
      if (summary.conversationId === conversationId) {
        delete pendingRequestSummariesById[id];
      }
    }
    for (const id of planIds) delete plansById[id];
    for (const id of diffIds) delete diffSummariesById[id];

    return {
      conversationsById,
      runtimesByConversationId,
      threadStreamsByConversationId,
      detailsByConversationId,
      messageIdsByConversationId,
      messagesById,
      turnIdsByConversationId,
      turnsById,
      itemIdsByConversationId,
      itemsById,
      outputIdsByItemId,
      outputsById,
      activityDetailsByItemId,
      timelineIdsByConversationId,
      pendingRequestIdsByConversationId,
      pendingRequestsById,
      pendingRequestSummariesById,
      planIdsByConversationId,
      plansById,
      diffSummaryIdsByConversationId,
      diffSummariesById,
      contextUsageByConversationId,
      reconciliationsByConversationId,
      latestRunByConversationId,
    };
  });
}

function handleConversationDeletedEvent(
  data: SseEventData<"chat_conversation_deleted">,
): void {
  removeConversationFromStore(data.conversationId);
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
    appServerStatus: data.appServer,
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

function handleReconciliationEvent(
  data:
    | SseEventData<"chat_reconciliation_started">
    | SseEventData<"chat_reconciliation_completed">
    | SseEventData<"chat_reconciliation_failed">,
): void {
  useChatStore.setState((state) =>
    applyReconciliationUpdated(state, data.reconciliation),
  );
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
      const nextConversations = indexConversations(data.chatConversations);
      const nextPendingRequestSummaries = indexPendingRequestSummaries(
        data.chatPendingRequests,
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
        const detailsByConversationId = Object.fromEntries(
          Object.entries(state.detailsByConversationId)
            .filter(([conversationId]) => conversationIds.has(conversationId))
            .map(([conversationId, detail]) => [
              conversationId,
              detail.status === "loaded"
                ? { ...detail, needsRefresh: true }
                : detail,
            ]),
        );

        return {
          appServerStatus: data.chatAppServer ?? null,
          conversationsById: nextConversations,
          runtimesByConversationId: indexRuntimes(data.chatRuntimes),
          threadStreamsByConversationId: indexThreadStreams(
            data.chatThreadStreams,
          ),
          detailsByConversationId,
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
            (data.chatContextUsage ?? []).map((usage) => [
              usage.conversationId,
              usage,
            ]),
          ),
          reconciliationsByConversationId: indexReconciliations(
            data.chatReconciliations,
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
    events.on("chat_conversation_deleted", handleConversationDeletedEvent),
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
    events.on("chat_reconciliation_started", handleReconciliationEvent),
    events.on("chat_reconciliation_completed", handleReconciliationEvent),
    events.on("chat_reconciliation_failed", handleReconciliationEvent),
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
    reconciliationsByConversationId: {},
    pendingRequestIdsByConversationId: {},
    pendingRequestsById: {},
    pendingRequestSummariesById: {},
    latestRunByConversationId: {},
    modelOptions: [],
    modelOptionsStatus: "idle",
    modelOptionsError: null,
  });
}
