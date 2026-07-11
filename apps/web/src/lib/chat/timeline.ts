import {
  hasAssistantMessageProjection,
  isActiveWorkStatus,
  isActivityItem,
  isReasoningItem,
  itemMetadata,
  normalizedReasoningText,
  sortItems,
  sortMessages,
} from "@/lib/chat/helpers";
import type { ChatViewModelState, ChatWorkGroupSlice } from "@/lib/chat/model";
import type {
  ChatDiffSummary,
  ChatItem,
  ChatMessage,
  ChatPendingRequest,
  ChatPlan,
  ChatTurn,
} from "@/lib/types";

const EMPTY_IDS: readonly string[] = [];
const INITIAL_WORK_SEGMENT_KEY = "initial";

type TimelineRow = {
  id: string;
  groupCreatedAt: number;
  groupSequence: number;
  priority: number;
  entityCreatedAt: number;
  entitySequence: number;
};

type TurnTimelineGroup = {
  turnId: string;
  groupCreatedAt: number;
  groupSequence: number;
  userMessages: ChatMessage[];
  assistantMessages: ChatMessage[];
  reasoningItems: ChatItem[];
  activityItems: ChatItem[];
  pendingRequests: ChatPendingRequest[];
  plans: ChatPlan[];
  diffSummaries: ChatDiffSummary[];
  turn: ChatTurn | null;
};

function isCommentaryReasoningItem(item: ChatItem): boolean {
  const metadata = itemMetadata(item);
  return metadata.type === "agentMessage" && metadata.phase === "commentary";
}

function visibleReasoningItems(items: readonly ChatItem[]): ChatItem[] {
  const sorted = sortItems(items);
  const commentaryTexts = sorted
    .filter(isCommentaryReasoningItem)
    .map(normalizedReasoningText)
    .filter((text) => text.length > 0);

  return sorted.filter((item) => {
    const text = normalizedReasoningText(item);
    if (isCommentaryReasoningItem(item)) {
      return text.length > 0 || isActiveWorkStatus(item.status);
    }
    if (text.length === 0 && !isActiveWorkStatus(item.status)) {
      return false;
    }
    if (commentaryTexts.some((commentary) => text.includes(commentary))) {
      return false;
    }
    return true;
  });
}

function updateTurnGroupAnchor(
  group: TurnTimelineGroup,
  createdAt: number,
  sequence: number,
): void {
  group.groupCreatedAt = Math.min(group.groupCreatedAt, createdAt);
  group.groupSequence = Math.min(group.groupSequence, sequence);
}

function getTurnGroup(
  groups: Map<string, TurnTimelineGroup>,
  turnId: string,
): TurnTimelineGroup {
  const existing = groups.get(turnId);
  if (existing) {
    return existing;
  }
  const group: TurnTimelineGroup = {
    turnId,
    groupCreatedAt: Number.MAX_SAFE_INTEGER,
    groupSequence: Number.MAX_SAFE_INTEGER,
    userMessages: [],
    assistantMessages: [],
    reasoningItems: [],
    activityItems: [],
    pendingRequests: [],
    plans: [],
    diffSummaries: [],
    turn: null,
  };
  groups.set(turnId, group);
  return group;
}

function shouldRenderWorkGroup(group: TurnTimelineGroup): boolean {
  return (
    group.activityItems.length > 0 ||
    visibleReasoningItems(group.reasoningItems).length > 0 ||
    group.pendingRequests.length > 0 ||
    group.plans.length > 0 ||
    group.diffSummaries.length > 0 ||
    group.assistantMessages.some(
      (message) => message.reasoningText.trim().length > 0,
    ) ||
    group.assistantMessages.some(
      (message) =>
        !hasAssistantMessageProjection(message) &&
        isActiveWorkStatus(message.status),
    ) ||
    isActiveWorkStatus(group.turn?.status)
  );
}

function workSegmentRowId(turnId: string, segmentKey: string): string {
  return `work:${turnId}:${segmentKey}`;
}

function workSegmentSortValue(
  segmentKey: string,
  group: TurnTimelineGroup,
): { createdAt: number; sequence: number } {
  if (segmentKey === INITIAL_WORK_SEGMENT_KEY) {
    return {
      createdAt: group.groupCreatedAt,
      sequence: group.groupSequence,
    };
  }
  const item = group.reasoningItems.find((item) => item.id === segmentKey);
  return {
    createdAt: item?.createdAt ?? group.groupCreatedAt,
    sequence: item?.sequence ?? group.groupSequence,
  };
}

function workSegmentKeysForGroup(group: TurnTimelineGroup): string[] {
  const reasoningItems = visibleReasoningItems(group.reasoningItems);
  if (reasoningItems.length === 0) {
    return shouldRenderWorkGroup(group) ? [INITIAL_WORK_SEGMENT_KEY] : [];
  }
  return reasoningItems.map((item) => item.id);
}

/** Builds ordered row IDs for a normalized conversation timeline. */
export function buildTimelineIds(
  messages: readonly ChatMessage[],
  turns: readonly ChatTurn[],
  items: readonly ChatItem[],
  pendingRequests: readonly ChatPendingRequest[] = [],
  plans: readonly ChatPlan[] = [],
  diffSummaries: readonly ChatDiffSummary[] = [],
): string[] {
  const rows: TimelineRow[] = [];
  const groups = new Map<string, TurnTimelineGroup>();

  for (const turn of turns) {
    const group = getTurnGroup(groups, turn.id);
    group.turn = turn;
    updateTurnGroupAnchor(group, turn.startedAt, turn.startedAt);
  }

  for (const message of messages) {
    if (!message.turnId) {
      if (hasAssistantMessageProjection(message)) {
        rows.push({
          id: `message:${message.role}:${message.id}`,
          groupCreatedAt: message.createdAt,
          groupSequence: message.sequence,
          priority: message.role === "user" ? 0 : 2,
          entityCreatedAt: message.createdAt,
          entitySequence: message.sequence,
        });
      }
      continue;
    }
    const group = getTurnGroup(groups, message.turnId);
    updateTurnGroupAnchor(group, message.createdAt, message.sequence);
    if (message.role === "user") {
      group.userMessages.push(message);
    } else {
      group.assistantMessages.push(message);
    }
  }

  for (const item of items) {
    if (!item.turnId) {
      if (isActivityItem(item)) {
        rows.push({
          id: `activity:${item.id}`,
          groupCreatedAt: item.createdAt,
          groupSequence: item.sequence,
          priority: 1,
          entityCreatedAt: item.createdAt,
          entitySequence: item.sequence,
        });
      }
      continue;
    }
    const group = getTurnGroup(groups, item.turnId);
    updateTurnGroupAnchor(group, item.createdAt, item.sequence);
    if (isReasoningItem(item)) {
      group.reasoningItems.push(item);
    } else if (isActivityItem(item)) {
      group.activityItems.push(item);
    }
  }

  for (const request of pendingRequests) {
    if (!request.turnId) {
      rows.push({
        id: `request:${request.id}`,
        groupCreatedAt: request.createdAt,
        groupSequence: request.sequence,
        priority: 1,
        entityCreatedAt: request.createdAt,
        entitySequence: request.sequence,
      });
      continue;
    }
    const group = getTurnGroup(groups, request.turnId);
    updateTurnGroupAnchor(group, request.createdAt, request.sequence);
    group.pendingRequests.push(request);
  }

  for (const plan of plans) {
    if (!plan.turnId) {
      rows.push({
        id: `plan:${plan.id}`,
        groupCreatedAt: plan.createdAt,
        groupSequence: plan.sequence,
        priority: 1,
        entityCreatedAt: plan.createdAt,
        entitySequence: plan.sequence,
      });
      continue;
    }
    const group = getTurnGroup(groups, plan.turnId);
    updateTurnGroupAnchor(group, plan.createdAt, plan.sequence);
    group.plans.push(plan);
  }

  for (const diff of diffSummaries) {
    if (!diff.turnId) {
      rows.push({
        id: `diff:${diff.id}`,
        groupCreatedAt: diff.createdAt,
        groupSequence: diff.sequence,
        priority: 1,
        entityCreatedAt: diff.createdAt,
        entitySequence: diff.sequence,
      });
      continue;
    }
    const group = getTurnGroup(groups, diff.turnId);
    updateTurnGroupAnchor(group, diff.createdAt, diff.sequence);
    group.diffSummaries.push(diff);
  }

  for (const group of groups.values()) {
    const anchorCreatedAt =
      group.groupCreatedAt === Number.MAX_SAFE_INTEGER
        ? 0
        : group.groupCreatedAt;
    const anchorSequence =
      group.groupSequence === Number.MAX_SAFE_INTEGER ? 0 : group.groupSequence;

    for (const message of sortMessages(group.userMessages)) {
      rows.push({
        id: `message:user:${message.id}`,
        groupCreatedAt: anchorCreatedAt,
        groupSequence: anchorSequence,
        priority: 0,
        entityCreatedAt: message.createdAt,
        entitySequence: message.sequence,
      });
    }
    for (const segmentKey of workSegmentKeysForGroup(group)) {
      const sortValue = workSegmentSortValue(segmentKey, group);
      rows.push({
        id: workSegmentRowId(group.turnId, segmentKey),
        groupCreatedAt: anchorCreatedAt,
        groupSequence: anchorSequence,
        priority: 1,
        entityCreatedAt: sortValue.createdAt,
        entitySequence: sortValue.sequence,
      });
    }
    for (const message of sortMessages(group.assistantMessages).filter(
      hasAssistantMessageProjection,
    )) {
      rows.push({
        id: `message:assistant:${message.id}`,
        groupCreatedAt: anchorCreatedAt,
        groupSequence: anchorSequence,
        priority: 2,
        entityCreatedAt: message.createdAt,
        entitySequence: message.sequence,
      });
    }
  }

  return rows
    .sort((left, right) => {
      if (left.groupCreatedAt !== right.groupCreatedAt) {
        return left.groupCreatedAt - right.groupCreatedAt;
      }
      if (left.groupSequence !== right.groupSequence) {
        return left.groupSequence - right.groupSequence;
      }
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      if (left.entitySequence !== right.entitySequence) {
        return left.entitySequence - right.entitySequence;
      }
      if (left.entityCreatedAt !== right.entityCreatedAt) {
        return left.entityCreatedAt - right.entityCreatedAt;
      }
      return left.id.localeCompare(right.id);
    })
    .map((row) => row.id);
}

/** Builds timeline row IDs from normalized view-model state. */
export function timelineIdsForState(
  state: ChatViewModelState,
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
  const messages = (state.messageIdsByConversationId[conversationId] ?? [])
    .map((id) => messagesById[id])
    .filter((message): message is ChatMessage => Boolean(message));
  const turns = (state.turnIdsByConversationId[conversationId] ?? [])
    .map((id) => state.turnsById[id])
    .filter((turn): turn is ChatTurn => Boolean(turn));
  const items = (state.itemIdsByConversationId[conversationId] ?? [])
    .map((id) => itemsById[id])
    .filter((item): item is ChatItem => Boolean(item));
  const requests = (
    state.pendingRequestIdsByConversationId[conversationId] ?? []
  )
    .map((id) => pendingRequestsById[id])
    .filter((request): request is ChatPendingRequest => Boolean(request));
  const plans = (state.planIdsByConversationId[conversationId] ?? [])
    .map((id) => plansById[id])
    .filter((plan): plan is ChatPlan => Boolean(plan));
  const diffs = (state.diffSummaryIdsByConversationId[conversationId] ?? [])
    .map((id) => diffSummariesById[id])
    .filter((diff): diff is ChatDiffSummary => Boolean(diff));
  return buildTimelineIds(messages, turns, items, requests, plans, diffs);
}

/** Derives the render slice for one turn work segment. */
export function deriveChatWorkGroupSlice(
  state: ChatViewModelState,
  conversationId: string,
  turnId: string,
  segmentKey: string = INITIAL_WORK_SEGMENT_KEY,
): ChatWorkGroupSlice {
  const turn = state.turnsById[turnId] ?? null;
  const messages = (state.messageIdsByConversationId[conversationId] ?? [])
    .map((id) => state.messagesById[id])
    .filter(
      (message): message is ChatMessage =>
        Boolean(message) && message.turnId === turnId,
    );
  const fallbackReasoningMessage =
    sortMessages(messages)
      .filter(
        (message) =>
          message.role === "assistant" &&
          message.reasoningText.trim().length > 0,
      )
      .at(-1) ?? null;
  const conversationItemIds =
    state.itemIdsByConversationId[conversationId] ?? [];
  const reasoningItems = visibleReasoningItems(
    conversationItemIds
      .map((id) => state.itemsById[id])
      .filter(
        (item): item is ChatItem =>
          Boolean(item) && item.turnId === turnId && isReasoningItem(item),
      ),
  );
  const reasoningMessage =
    reasoningItems.length === 0 ? fallbackReasoningMessage : null;
  const reasoningItem =
    segmentKey === INITIAL_WORK_SEGMENT_KEY
      ? null
      : (reasoningItems.find((item) => item.id === segmentKey) ?? null);
  const previousReasoningItem = reasoningItem
    ? reasoningItems
        .filter((item) => item.sequence < reasoningItem.sequence)
        .at(-1)
    : null;
  const nextReasoningItem = reasoningItem
    ? reasoningItems.find((item) => item.sequence > reasoningItem.sequence)
    : reasoningItems[0];
  const lowerSequence = previousReasoningItem
    ? (reasoningItem?.sequence ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const upperSequence = nextReasoningItem?.sequence ?? Number.POSITIVE_INFINITY;
  const inSegment = (sequence: number) =>
    segmentKey === INITIAL_WORK_SEGMENT_KEY
      ? sequence < upperSequence
      : sequence > lowerSequence && sequence < upperSequence;
  const activityIds = conversationItemIds.filter((id) => {
    const item = state.itemsById[id];
    return (
      Boolean(item) &&
      item.turnId === turnId &&
      isActivityItem(item) &&
      inSegment(item.sequence)
    );
  });
  const pendingRequestIds = (
    state.pendingRequestIdsByConversationId[conversationId] ?? []
  ).filter((id) => {
    const request = state.pendingRequestsById[id];
    return (
      Boolean(request) &&
      request.turnId === turnId &&
      inSegment(request.sequence)
    );
  });
  const planIds = (state.planIdsByConversationId[conversationId] ?? []).filter(
    (id) => {
      const plan = state.plansById[id];
      return (
        Boolean(plan) && plan.turnId === turnId && inSegment(plan.sequence)
      );
    },
  );
  const diffSummaryIds = (
    state.diffSummaryIdsByConversationId[conversationId] ?? []
  ).filter((id) => {
    const diff = state.diffSummariesById[id];
    return Boolean(diff) && diff.turnId === turnId && inSegment(diff.sequence);
  });
  const lastSegmentKey = reasoningItems.at(-1)?.id ?? INITIAL_WORK_SEGMENT_KEY;
  const active =
    (segmentKey === lastSegmentKey && isActiveWorkStatus(turn?.status)) ||
    (segmentKey === lastSegmentKey &&
      messages.some((message) => isActiveWorkStatus(message.status))) ||
    isActiveWorkStatus(reasoningItem?.status) ||
    activityIds.some((id) => isActiveWorkStatus(state.itemsById[id]?.status)) ||
    pendingRequestIds.some((id) =>
      isActiveWorkStatus(state.pendingRequestsById[id]?.status),
    ) ||
    planIds.some((id) => isActiveWorkStatus(state.plansById[id]?.status));
  const status = active ? "working" : (turn?.status ?? "completed");

  return {
    turn,
    reasoningMessage,
    reasoningItem,
    activityIds: activityIds.length > 0 ? activityIds : EMPTY_IDS,
    pendingRequestIds:
      pendingRequestIds.length > 0 ? pendingRequestIds : EMPTY_IDS,
    planIds: planIds.length > 0 ? planIds : EMPTY_IDS,
    diffSummaryIds: diffSummaryIds.length > 0 ? diffSummaryIds : EMPTY_IDS,
    active,
    status,
  };
}
