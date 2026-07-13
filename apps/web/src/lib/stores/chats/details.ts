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
import { buildTimelineIds, timelineIdsForState } from "@/lib/chat/timeline";
import { getChat, getChatActivity } from "@/lib/api";
import type { ChatActivityDetail, ChatConversationDetail } from "@/lib/types";
import { mergeConversationIntoOpenTabs } from "./conversation";
import {
  DEFAULT_ACTIVITY_DETAIL_STATE,
  DEFAULT_DETAIL_STATE,
  type ChatStoreApi,
  itemIdsFromState,
  loadedDetailState,
  mapById,
  sortedIds,
} from "./state";

function setDetail(
  store: ChatStoreApi,
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

  store.setState((state) => {
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

export async function loadConversation(
  store: ChatStoreApi,
  conversationId: string,
): Promise<ChatConversationDetail | null> {
  store.setState((state) => ({
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
    setDetail(store, conversationId, detail);
    return detail;
  } catch (error) {
    store.setState((state) => ({
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

export async function loadActivity(
  store: ChatStoreApi,
  conversationId: string,
  itemId: string,
): Promise<ChatActivityDetail | null> {
  store.setState((state) => ({
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
    store.setState((state) => {
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
    store.setState((state) => ({
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
