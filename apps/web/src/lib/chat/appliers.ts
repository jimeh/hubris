import {
  hasAssistantMessageProjection,
  sortDiffSummaries,
  sortItems,
  sortMessages,
  sortOutputs,
  sortPendingRequests,
  sortPlans,
  sortRuns,
  sortTurns,
  upsertSortedEntity,
} from "@/lib/chat/helpers";
import type { ChatViewModelState } from "@/lib/chat/model";
import { timelineIdsForState } from "@/lib/chat/timeline";
import type { SseEventData } from "@/lib/events";
import type {
  ChatContextUsage,
  ChatDiffSummary,
  ChatItem,
  ChatMessage,
  ChatPendingRequest,
  ChatPlan,
  ChatReconciliation,
  ChatRun,
  ChatTurn,
} from "@/lib/types";

/** A normalized queued chat SSE event. */
export type ChatBatchEvent =
  | { type: "message_delta"; data: SseEventData<"chat_message_delta"> }
  | { type: "message_updated"; data: SseEventData<"chat_message_updated"> }
  | { type: "run_updated"; data: SseEventData<"chat_run_updated"> }
  | { type: "turn_updated"; data: SseEventData<"chat_turn_updated"> }
  | { type: "item_updated"; data: SseEventData<"chat_item_updated"> }
  | { type: "activity_delta"; data: SseEventData<"chat_activity_delta"> }
  | { type: "activity_updated"; data: SseEventData<"chat_activity_updated"> }
  | {
      type: "pending_request_updated";
      data:
        | SseEventData<"chat_pending_request_created">
        | SseEventData<"chat_pending_request_updated">
        | SseEventData<"chat_pending_request_resolved">;
    }
  | { type: "plan_updated"; data: SseEventData<"chat_plan_updated"> }
  | { type: "diff_updated"; data: SseEventData<"chat_diff_updated"> }
  | {
      type: "context_usage_updated";
      data: SseEventData<"chat_context_usage_updated">;
    };

const DEFAULT_DETAIL_STATE = {
  status: "idle" as const,
  error: null,
  needsRefresh: false,
};

function loadedDetailState() {
  return {
    status: "loaded" as const,
    error: null,
    needsRefresh: false,
  };
}

function idsFor(
  byConversationId: Record<string, string[]>,
  conversationId: string,
): readonly string[] {
  return byConversationId[conversationId] ?? [];
}

function isConversationLoaded(
  state: ChatViewModelState,
  conversationId: string,
): boolean {
  return state.detailsByConversationId[conversationId]?.status === "loaded";
}

function markConversationDirtyInBatch(
  state: ChatViewModelState,
  conversationId: string,
): ChatViewModelState {
  const current =
    state.detailsByConversationId[conversationId] ?? DEFAULT_DETAIL_STATE;
  return {
    ...state,
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: { ...current, needsRefresh: true },
    },
  };
}

function applyMessageUpdated(
  state: ChatViewModelState,
  conversationId: string,
  message: ChatMessage,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const messagesById = { ...state.messagesById, [message.id]: message };
  const messageIdsByConversationId = {
    ...state.messageIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.messageIdsByConversationId, conversationId),
      messagesById,
      message,
      sortMessages,
    ),
  };
  const nextState = { ...state, messagesById, messageIdsByConversationId };
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
  state: ChatViewModelState,
  data: SseEventData<"chat_message_delta">,
): ChatViewModelState {
  if (!isConversationLoaded(state, data.conversation_id)) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  const message = state.messagesById[data.message_id];
  if (!message) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  const nextMessage = {
    ...message,
    contentText: `${message.contentText}${data.delta}`,
  };
  const messagesById = {
    ...state.messagesById,
    [data.message_id]: nextMessage,
  };
  const nextState = { ...state, messagesById };
  return {
    ...nextState,
    timelineIdsByConversationId:
      !hasAssistantMessageProjection(message) &&
      hasAssistantMessageProjection(nextMessage)
        ? {
            ...state.timelineIdsByConversationId,
            [data.conversation_id]: timelineIdsForState(
              nextState,
              data.conversation_id,
              messagesById,
            ),
          }
        : state.timelineIdsByConversationId,
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [data.conversation_id]: loadedDetailState(),
    },
  };
}

function applyRunUpdated(
  state: ChatViewModelState,
  conversationId: string,
  run: ChatRun,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const existing = state.latestRunByConversationId[conversationId];
  const runs = [existing].filter(
    (candidate): candidate is ChatRun =>
      candidate !== null && candidate.id !== run.id,
  );
  return {
    ...state,
    latestRunByConversationId: {
      ...state.latestRunByConversationId,
      [conversationId]: sortRuns([...runs, run])[0] ?? null,
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyTurnUpdated(
  state: ChatViewModelState,
  conversationId: string,
  turn: ChatTurn,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const turnsById = { ...state.turnsById, [turn.id]: turn };
  const turnIdsByConversationId = {
    ...state.turnIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.turnIdsByConversationId, conversationId),
      turnsById,
      turn,
      sortTurns,
    ),
  };
  const nextState = { ...state, turnsById, turnIdsByConversationId };
  return {
    ...nextState,
    timelineIdsByConversationId: {
      ...nextState.timelineIdsByConversationId,
      [conversationId]: timelineIdsForState(nextState, conversationId),
    },
    detailsByConversationId: {
      ...nextState.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  };
}

function applyItemUpdated(
  state: ChatViewModelState,
  conversationId: string,
  item: ChatItem,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const itemsById = { ...state.itemsById, [item.id]: item };
  const itemIdsByConversationId = {
    ...state.itemIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.itemIdsByConversationId, conversationId),
      itemsById,
      item,
      sortItems,
    ),
  };
  const nextState = { ...state, itemsById, itemIdsByConversationId };
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
  state: ChatViewModelState,
  request: ChatPendingRequest,
): ChatViewModelState {
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
      { ...state, pendingRequestSummariesById },
      conversationId,
    );
  }
  const pendingRequestsById = {
    ...state.pendingRequestsById,
    [request.id]: request,
  };
  const pendingRequestIdsByConversationId = {
    ...state.pendingRequestIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.pendingRequestIdsByConversationId, conversationId),
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
  state: ChatViewModelState,
  conversationId: string,
  plan: ChatPlan,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const plansById = { ...state.plansById, [plan.id]: plan };
  const planIdsByConversationId = {
    ...state.planIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.planIdsByConversationId, conversationId),
      plansById,
      plan,
      sortPlans,
    ),
  };
  const nextState = { ...state, plansById, planIdsByConversationId };
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
  state: ChatViewModelState,
  conversationId: string,
  diff: ChatDiffSummary,
): ChatViewModelState {
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(state, conversationId);
  }
  const diffSummariesById = { ...state.diffSummariesById, [diff.id]: diff };
  const diffSummaryIdsByConversationId = {
    ...state.diffSummaryIdsByConversationId,
    [conversationId]: upsertSortedEntity(
      idsFor(state.diffSummaryIdsByConversationId, conversationId),
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
  state: ChatViewModelState,
  usage: ChatContextUsage,
): ChatViewModelState {
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
  state: ChatViewModelState,
  data: SseEventData<"chat_activity_delta">,
): ChatViewModelState {
  if (!isConversationLoaded(state, data.conversation_id)) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  if (!state.itemsById[data.item_id]) {
    return markConversationDirtyInBatch(state, data.conversation_id);
  }
  const output = data.output;
  const outputsById = { ...state.outputsById, [output.id]: output };
  return {
    ...state,
    outputsById,
    outputIdsByItemId: {
      ...state.outputIdsByItemId,
      [data.item_id]: upsertSortedEntity(
        state.outputIdsByItemId[data.item_id] ?? [],
        outputsById,
        output,
        sortOutputs,
      ),
    },
    activityDetailsByItemId: {
      ...state.activityDetailsByItemId,
      [data.item_id]: {
        status:
          state.activityDetailsByItemId[data.item_id]?.status === "loaded"
            ? "loaded"
            : "partial",
        error: null,
      },
    },
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [data.conversation_id]: loadedDetailState(),
    },
  };
}

/** Folds a reconciliation update into chat view-model state. */
export function applyReconciliationUpdated<T extends ChatViewModelState>(
  state: T,
  reconciliation: ChatReconciliation,
): T {
  const conversationId = reconciliation.conversationId;
  const nextState = {
    ...state,
    reconciliationsByConversationId: {
      ...state.reconciliationsByConversationId,
      [conversationId]: reconciliation,
    },
  };
  if (!isConversationLoaded(state, conversationId)) {
    return markConversationDirtyInBatch(nextState, conversationId) as T;
  }
  return {
    ...nextState,
    detailsByConversationId: {
      ...state.detailsByConversationId,
      [conversationId]: loadedDetailState(),
    },
  } as T;
}

/** Folds a queued SSE batch into chat view-model state. */
export function applyQueuedChatEvents<T extends ChatViewModelState>(
  state: T,
  events: readonly ChatBatchEvent[],
): T {
  return events.reduce<ChatViewModelState>((nextState, event) => {
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
      case "activity_updated":
        return applyItemUpdated(
          nextState,
          event.data.conversation_id,
          event.data.item,
        );
      case "activity_delta":
        return applyActivityDelta(nextState, event.data);
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
  }, state) as T;
}
