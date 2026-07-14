import type {
  ChatConversationDetail,
  ChatItem,
  ChatMessage,
  ChatPendingRequest,
  ChatTurn,
} from "@/lib/types";

const LONG_CHAT_TURN_COUNT = 250;

/** Builds a deterministic 250-turn transcript for long-chat regression tests. */
export function makeLongChatDetail({
  liveFinalTurn = false,
}: {
  liveFinalTurn?: boolean;
} = {}): ChatConversationDetail {
  const messages: ChatMessage[] = [];
  const turns: ChatTurn[] = [];
  const items: ChatItem[] = [];
  const pendingRequests: ChatPendingRequest[] = [];

  for (let index = 0; index < LONG_CHAT_TURN_COUNT; index += 1) {
    const sequence = index * 6;
    const turnId = `turn-${index}`;
    const userMessageId = `message-user-${index}`;
    const assistantMessageId = `message-assistant-${index}`;
    const isLiveTurn = liveFinalTurn && index === LONG_CHAT_TURN_COUNT - 1;

    messages.push(
      {
        id: userMessageId,
        conversationId: "chat-1",
        turnId,
        itemId: null,
        providerTurnId: `provider-turn-${index}`,
        providerItemId: null,
        role: "user",
        status: "completed",
        contentText: `User request ${index}`,
        reasoningText: "",
        sequence,
        createdAt: sequence,
        updatedAt: sequence,
      },
      {
        id: assistantMessageId,
        conversationId: "chat-1",
        turnId,
        itemId: null,
        providerTurnId: `provider-turn-${index}`,
        providerItemId: null,
        role: "assistant",
        status: isLiveTurn ? "streaming" : "completed",
        contentText: `Assistant response ${index}`,
        reasoningText: "",
        sequence: sequence + 5,
        createdAt: sequence + 5,
        updatedAt: sequence + 5,
      },
    );
    turns.push({
      id: turnId,
      conversationId: "chat-1",
      runId: `run-${index}`,
      providerTurnId: `provider-turn-${index}`,
      userMessageId,
      assistantMessageId,
      status: isLiveTurn ? "running" : "completed",
      reconciliationStatus: "not_needed",
      reconciliationError: null,
      errorMessage: null,
      startedAt: sequence,
      completedAt: isLiveTurn ? null : sequence + 5,
      reconciledAt: null,
      createdAt: sequence,
      updatedAt: sequence + 5,
    });
    items.push({
      id: `reasoning-${index}`,
      conversationId: "chat-1",
      turnId,
      providerTurnId: `provider-turn-${index}`,
      providerItemId: `reasoning-item-${index}`,
      kind: "reasoning",
      status: "completed",
      role: "assistant",
      title: "Reasoning",
      summary: `Checked repository state for turn ${index}`,
      sequence: sequence + 1,
      metadataJson: "{}",
      createdAt: sequence + 1,
      updatedAt: sequence + 1,
      completedAt: sequence + 1,
    });
    if (index % 5 === 0) {
      items.push({
        id: `command-${index}`,
        conversationId: "chat-1",
        turnId,
        providerTurnId: `provider-turn-${index}`,
        providerItemId: `command-item-${index}`,
        kind: "command_execution",
        status: "completed",
        role: "assistant",
        title: "Run checks",
        summary: "mise run check",
        sequence: sequence + 2,
        metadataJson: JSON.stringify({ command: "mise run check" }),
        createdAt: sequence + 2,
        updatedAt: sequence + 2,
        completedAt: sequence + 2,
      });
    }
    if (index % 10 === 0) {
      pendingRequests.push({
        id: `request-${index}`,
        conversationId: "chat-1",
        turnId,
        itemId: null,
        providerRequestId: `provider-request-${index}`,
        providerTurnId: `provider-turn-${index}`,
        providerItemId: null,
        method: "item/commandExecution/requestApproval",
        kind: "command_approval",
        status: "resolved",
        decision: "accept",
        ownerGeneration: 1,
        sequence: sequence + 3,
        payloadJson: JSON.stringify({ command: `echo turn-${index}` }),
        responseJson: JSON.stringify({ decision: "accept" }),
        errorMessage: null,
        createdAt: sequence + 3,
        updatedAt: sequence + 4,
        resolvedAt: sequence + 4,
      });
    }
  }

  const finalTimestamp = LONG_CHAT_TURN_COUNT * 6;

  return {
    conversation: {
      id: "chat-1",
      sessionId: "default",
      projectId: "project-1",
      worktreeId: "worktree-1",
      provider: "codex",
      providerThreadId: "thread-1",
      title: "Long Codex Chat",
      createdAt: 0,
      updatedAt: finalTimestamp,
      lastActivityAt: finalTimestamp,
      lastMessageAt: finalTimestamp - 1,
      openTabId: "tab-chat-1",
      archivedAt: null,
      selectedModel: null,
      selectedEffort: null,
      selectedPermissionMode: null,
      lastRunState: liveFinalTurn ? "running" : "completed",
      lastError: null,
      lastReconciliationState: "not_needed",
      lastReconciliationError: null,
      pendingRequestCount: 0,
      latestPendingRequestId: null,
      latestPendingRequestKind: null,
      latestPendingRequestStatus: null,
      hasPendingRequestAttention: false,
      contextUsedTokens: 72_000,
      contextMaxTokens: 128_000,
      contextPercentUsed: 56.25,
      contextUpdatedAt: finalTimestamp,
      revision: 1,
    },
    messages,
    turns,
    items,
    plans: [],
    diffSummaries: [],
    contextUsage: {
      id: "context-usage-1",
      conversationId: "chat-1",
      providerThreadId: "thread-1",
      usedTokens: 72_000,
      maxTokens: 128_000,
      totalProcessedTokens: 180_000,
      percentUsed: 56.25,
      metadataJson: "{}",
      updatedAt: finalTimestamp,
    },
    pendingRequests,
    latestReconciliation: null,
    latestRun: null,
  };
}
