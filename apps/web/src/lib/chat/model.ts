import type {
  ChatContextUsage,
  ChatDiffSummary,
  ChatItem,
  ChatItemOutput,
  ChatMessage,
  ChatPendingRequest,
  ChatPendingRequestSummary,
  ChatPlan,
  ChatReconciliation,
  ChatRun,
  ChatTurn,
} from "@/lib/types";

/** Loading state for a normalized conversation detail. */
export type ConversationDetailState = {
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  needsRefresh: boolean;
};

/** Loading state for a normalized activity detail. */
export type ActivityDetailState = {
  status: "idle" | "loading" | "partial" | "loaded" | "error";
  error: string | null;
};

/** Normalized chat state consumed by pure view-model functions. */
export type ChatViewModelState = {
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
  reconciliationsByConversationId: Record<string, ChatReconciliation>;
  pendingRequestIdsByConversationId: Record<string, string[]>;
  pendingRequestsById: Record<string, ChatPendingRequest>;
  pendingRequestSummariesById: Record<string, ChatPendingRequestSummary>;
  latestRunByConversationId: Record<string, ChatRun | null>;
};

/** Derived data rendered by one timeline work segment. */
export type ChatWorkGroupSlice = {
  turn: ChatTurn | null;
  reasoningMessage: ChatMessage | null;
  reasoningItem: ChatItem | null;
  activityIds: readonly string[];
  pendingRequestIds: readonly string[];
  planIds: readonly string[];
  diffSummaryIds: readonly string[];
  active: boolean;
  status: string;
};
