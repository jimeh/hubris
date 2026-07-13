import { create } from "zustand";
import {
  archiveChat,
  deleteChat,
  interruptChat,
  listChatModels,
  patchChatSettings,
  resolveChatPendingRequest,
  sendChatMessage,
  unarchiveChat,
} from "@/lib/api";
import {
  handleConversationEvent,
  removeConversationFromStore,
} from "./conversation";
import { loadActivity, loadConversation } from "./details";
import {
  type ChatStoreApi,
  type ChatStoreState,
  denormalizeActivityDetail,
  denormalizeConversationDetail,
  normalizeModelOptions,
} from "./state";

export const useChatStore = create<ChatStoreState>((set, get) => {
  const store: ChatStoreApi = {
    getState: get,
    setState: set,
  };

  return {
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
      return loadConversation(store, conversationId);
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
      return loadConversation(store, conversationId);
    },
    async ensureActivityLoaded(conversationId, itemId) {
      const current = get().activityDetailsByItemId[itemId];
      if (current?.status === "loaded") {
        return denormalizeActivityDetail(get(), itemId);
      }
      if (current?.status === "loading") {
        return denormalizeActivityDetail(get(), itemId);
      }
      return loadActivity(store, conversationId, itemId);
    },
    async sendMessage(conversationId, text, worktreeId) {
      await sendChatMessage(conversationId, text, worktreeId);
    },
    async archiveConversation(conversationId) {
      const summary = await archiveChat(conversationId);
      handleConversationEvent(store, {
        sessionId: summary.sessionId,
        conversation: summary,
      });
    },
    async unarchiveConversation(conversationId) {
      const summary = await unarchiveChat(conversationId);
      handleConversationEvent(store, {
        sessionId: summary.sessionId,
        conversation: summary,
      });
    },
    async deleteConversation(conversationId) {
      await deleteChat(conversationId);
      removeConversationFromStore(store, conversationId);
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
      handleConversationEvent(store, {
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
        const latestRunByConversationId = {
          ...state.latestRunByConversationId,
        };
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
  };
});
