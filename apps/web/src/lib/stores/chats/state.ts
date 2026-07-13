import type { StoreApi } from "zustand";
import type {
  ActivityDetailState,
  ChatViewModelState,
  ConversationDetailState,
} from "@/lib/chat/model";
import type {
  ChatConversationSummary as ApiChatConversationSummary,
  ChatModelOption as ApiChatModelOption,
  ChatRuntimeStatus as ApiChatRuntimeStatus,
  ChatThreadStreamStatus as ApiChatThreadStreamStatus,
} from "@/lib/api";
import type {
  ChatActivityDetail,
  ChatAppServerStatus,
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
  ChatRuntimeStatus,
  ChatThreadStreamStatus,
  ChatTurn,
} from "@/lib/types";

export type ChatStoreState = ChatViewModelState & {
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

export type ChatStoreApi = Pick<
  StoreApi<ChatStoreState>,
  "getState" | "setState"
>;

export const DEFAULT_DETAIL_STATE: ConversationDetailState = {
  status: "idle",
  error: null,
  needsRefresh: false,
};

export const EMPTY_IDS: readonly string[] = [];
export const EMPTY_THREAD_MESSAGES: readonly never[] = [];

export const DEFAULT_ACTIVITY_DETAIL_STATE: ActivityDetailState = {
  status: "idle",
  error: null,
};

export function indexConversations(
  conversations: readonly ApiChatConversationSummary[],
): Record<string, ChatConversationSummary> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
}

export function indexRuntimes(
  runtimes: readonly ApiChatRuntimeStatus[],
): Record<string, ChatRuntimeStatus> {
  return Object.fromEntries(
    runtimes.map((runtime) => [runtime.conversationId, runtime]),
  );
}

export function indexThreadStreams(
  streams: readonly ApiChatThreadStreamStatus[] = [],
): Record<string, ChatThreadStreamStatus> {
  return Object.fromEntries(
    streams.map((stream) => [stream.conversationId, stream]),
  );
}

export function indexPendingRequestSummaries(
  requests: readonly ChatPendingRequestSummary[] = [],
): Record<string, ChatPendingRequestSummary> {
  return Object.fromEntries(requests.map((request) => [request.id, request]));
}

export function indexReconciliations(
  reconciliations: readonly ChatReconciliation[] = [],
): Record<string, ChatReconciliation> {
  return Object.fromEntries(
    reconciliations.map((reconciliation) => [
      reconciliation.conversationId,
      reconciliation,
    ]),
  );
}

export function normalizeModelOptions(
  models: readonly ApiChatModelOption[],
): ChatModelOption[] {
  return [...models].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return left.displayName.localeCompare(right.displayName);
  });
}

export function messageIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.messageIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function turnIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.turnIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function itemIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.itemIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function pendingRequestIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.pendingRequestIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function planIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.planIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function diffSummaryIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.diffSummaryIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function timelineIdsFromState(
  state: ChatStoreState,
  conversationId: string,
): readonly string[] {
  return state.timelineIdsByConversationId[conversationId] ?? EMPTY_IDS;
}

export function outputIdsFromState(
  state: ChatStoreState,
  itemId: string,
): readonly string[] {
  return state.outputIdsByItemId[itemId] ?? EMPTY_IDS;
}

export function denormalizeConversationDetail(
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

export function denormalizeActivityDetail(
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

export function mapById<T extends { id: string }>(
  items: readonly T[],
): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function sortedIds<T extends { id: string }>(
  items: readonly T[],
  sorter: (items: readonly T[]) => T[],
): string[] {
  return sorter(items).map((item) => item.id);
}

export function loadedDetailState(): ConversationDetailState {
  return {
    status: "loaded",
    error: null,
    needsRefresh: false,
  };
}
