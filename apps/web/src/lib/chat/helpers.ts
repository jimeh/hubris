import type {
  ChatDiffSummary,
  ChatItem,
  ChatItemOutput,
  ChatMessage,
  ChatPendingRequest,
  ChatPlan,
  ChatRun,
  ChatRuntimeLifecycle,
  ChatTurn,
} from "@/lib/types";

/** Returns whether a runtime lifecycle represents active execution. */
export function isRuntimeRunning(
  lifecycle: ChatRuntimeLifecycle | undefined,
): boolean {
  return lifecycle === "starting" || lifecycle === "running";
}

/** Parses item metadata as an object, falling back to an empty record. */
export function itemMetadata(
  item: ChatItem | null | undefined,
): Record<string, unknown> {
  if (!item) {
    return {};
  }
  try {
    const value = JSON.parse(item.metadataJson);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Returns the classic chat label for an activity item. */
export function activityLabel(item: ChatItem): string {
  if (item.title) {
    return item.title;
  }
  switch (item.kind) {
    case "command_execution":
      return "Run command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "View image";
    case "hook":
      return "Run hook";
    case "auto_approval_review":
      return "Permission review";
    case "model_reroute":
      return "Model rerouted";
    default:
      return "Activity";
  }
}

/** Returns the classic chat status label for an activity item. */
export function activityStatusLabel(item: ChatItem): string {
  switch (item.status) {
    case "started":
      return "Started";
    case "streaming":
      return "Running";
    case "failed":
      return "Failed";
    default:
      return "Completed";
  }
}

/** Returns whether an item belongs in the activity lane. */
export function isActivityItem(item: ChatItem): boolean {
  return item.kind !== "agent_message" && item.kind !== "reasoning";
}

/** Returns whether an item carries reasoning content. */
export function isReasoningItem(item: ChatItem): boolean {
  return item.kind === "reasoning";
}

/** Normalizes reasoning text for visibility and duplicate checks. */
export function normalizedReasoningText(
  item: ChatItem | null | undefined,
): string {
  return (item?.summary ?? "").replace(/\s+/g, " ").trim();
}

/** Returns whether a status represents unfinished work. */
export function isActiveWorkStatus(status: string | null | undefined): boolean {
  return (
    status === "pending" ||
    status === "starting" ||
    status === "running" ||
    status === "started" ||
    status === "streaming" ||
    status === "resolving"
  );
}

/** Returns whether a message should have a transcript row. */
export function hasAssistantMessageProjection(message: ChatMessage): boolean {
  if (message.role !== "assistant") {
    return true;
  }
  if (message.contentText.trim().length > 0) {
    return true;
  }
  return (
    message.status === "completed" ||
    message.status === "failed" ||
    message.status === "interrupted"
  );
}

/** Returns messages in stable timeline order. */
export function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Returns runs newest first. */
export function sortRuns(runs: readonly ChatRun[]): ChatRun[] {
  return [...runs].sort((left, right) => right.startedAt - left.startedAt);
}

/** Returns turns in stable timeline order. */
export function sortTurns(turns: readonly ChatTurn[]): ChatTurn[] {
  return [...turns].sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt - right.startedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

/** Returns items in stable timeline order. */
export function sortItems(items: readonly ChatItem[]): ChatItem[] {
  return [...items].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Returns activity outputs in stable stream order. */
export function sortOutputs(
  outputs: readonly ChatItemOutput[],
): ChatItemOutput[] {
  return [...outputs].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Returns pending requests in stable timeline order. */
export function sortPendingRequests(
  requests: readonly ChatPendingRequest[],
): ChatPendingRequest[] {
  return [...requests].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Returns plans in stable timeline order. */
export function sortPlans(plans: readonly ChatPlan[]): ChatPlan[] {
  return [...plans].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Returns diff summaries in stable timeline order. */
export function sortDiffSummaries(
  summaries: readonly ChatDiffSummary[],
): ChatDiffSummary[] {
  return [...summaries].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.createdAt - right.createdAt;
  });
}

/** Upserts an entity ID and returns IDs in the supplied stable order. */
export function upsertSortedEntity<T extends { id: string }>(
  ids: readonly string[],
  byId: Record<string, T>,
  entity: T,
  sorter: (items: readonly T[]) => T[],
): string[] {
  const nextById = { ...byId, [entity.id]: entity };
  const nextIds = ids.includes(entity.id) ? [...ids] : [...ids, entity.id];
  return sorter(
    nextIds
      .map((id) => nextById[id])
      .filter((item): item is T => Boolean(item)),
  ).map((item) => item.id);
}
