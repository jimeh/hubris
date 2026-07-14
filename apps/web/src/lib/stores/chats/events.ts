import {
  applyQueuedChatEvents,
  applyReconciliationUpdated,
  type ChatBatchEvent,
} from "@/lib/chat/appliers";
import { getEventClient, type SseEventData } from "@/lib/events";
import {
  handleConversationEvent,
  removeConversationFromStore,
} from "./conversation";
import {
  invalidateLoadsOutsideSnapshot,
  resetLoadOwnershipForTests,
} from "./load-ownership";
import {
  indexConversations,
  indexPendingRequestSummaries,
  indexReconciliations,
  indexRuntimes,
  indexThreadStreams,
} from "./state";
import { useChatStore } from "./store";

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];
let queuedChatEvents: ChatBatchEvent[] = [];
let queuedChatFrame: number | null = null;

function handleConversationDeletedEvent(
  data: SseEventData<"chat_conversation_deleted">,
): void {
  flushQueuedChatEvents();
  removeConversationFromStore(useChatStore, data.conversationId);
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
      const conversationIds = new Set(Object.keys(nextConversations));
      invalidateLoadsOutsideSnapshot(conversationIds);
      useChatStore.setState((state) => {
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
    events.on("chat_conversation_created", (data) =>
      handleConversationEvent(useChatStore, data),
    ),
    events.on("chat_conversation_updated", (data) =>
      handleConversationEvent(useChatStore, data),
    ),
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
  resetLoadOwnershipForTests();
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
