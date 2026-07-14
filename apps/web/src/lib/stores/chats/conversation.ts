import type { SseEventData } from "@/lib/events";
import { useTabStore } from "@/lib/stores/tabs";
import type { ChatConversationSummary } from "@/lib/types";
import { invalidateConversationLoads } from "./load-ownership";
import type { ChatStoreApi } from "./state";

export function mergeConversationIntoOpenTabs(
  conversation: ChatConversationSummary,
): void {
  useTabStore
    .getState()
    .updateAgentChatTitle(conversation.id, conversation.title);
}

export function handleConversationEvent(
  store: ChatStoreApi,
  data:
    | SseEventData<"chat_conversation_created">
    | SseEventData<"chat_conversation_updated">,
): void {
  store.setState((state) => ({
    conversationsById: {
      ...state.conversationsById,
      [data.conversation.id]: data.conversation,
    },
  }));
  mergeConversationIntoOpenTabs(data.conversation);
}

export function removeConversationFromStore(
  store: ChatStoreApi,
  conversationId: string,
): void {
  invalidateConversationLoads(conversationId);
  store.setState((state) => {
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
