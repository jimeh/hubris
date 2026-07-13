import type {
  ActivityDetailState,
  ConversationDetailState,
} from "@/lib/chat/model";
import { deriveChatWorkGroupSlice } from "@/lib/chat/timeline";
import type {
  ChatContextUsage,
  ChatConversationSummary,
  ChatDiffSummary,
  ChatItem,
  ChatItemOutput,
  ChatMessage,
  ChatModelOption,
  ChatPendingRequest,
  ChatPlan,
  ChatReconciliation,
  ChatRun,
  ChatRuntimeStatus,
} from "@/lib/types";
import {
  DEFAULT_ACTIVITY_DETAIL_STATE,
  DEFAULT_DETAIL_STATE,
  EMPTY_IDS,
  EMPTY_THREAD_MESSAGES,
  type ChatStoreState,
  messageIdsFromState,
  outputIdsFromState,
  pendingRequestIdsFromState,
  timelineIdsFromState,
} from "./state";

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
