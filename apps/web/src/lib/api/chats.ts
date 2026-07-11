import type { components } from "@/lib/contracts/rest.generated";
import { apiBase } from "@/lib/desktopRuntime";
import { ApiStatusError, requestJson, requestVoid } from "./client";

export type ChatConversationSummary =
  components["schemas"]["ChatConversationSummary"];
export type ChatConversationDetail =
  components["schemas"]["ChatConversationDetail"];
export type ChatActivityDetail = components["schemas"]["ChatActivityDetail"];
export type ChatPendingRequest = components["schemas"]["ChatPendingRequest"];
export type ChatRuntimeStatus = components["schemas"]["ChatRuntimeStatus"];
export type ChatThreadStreamStatus =
  components["schemas"]["ChatThreadStreamStatus"];
export type ChatModelOption = components["schemas"]["ChatModelOption"];
export type ChatPermissionMode = components["schemas"]["ChatPermissionMode"];
export type ChatConversationSettingsPatch =
  components["schemas"]["ChatConversationSettingsPatch"];
export type ResolveChatPendingRequestRequest =
  components["schemas"]["ResolveChatPendingRequestRequest"];

const BASE = apiBase();

export async function listProjectWorktreeChats(
  projectId: string,
  worktreeId: string,
  sessionId = "default",
  options: {
    scope?: "branch" | "project";
    includeArchived?: boolean;
  } = {},
): Promise<ChatConversationSummary[]> {
  return requestJson(
    "GET",
    "/api/projects/{project_id}/worktrees/{worktree_id}/chats",
    {
      path: { project_id: projectId, worktree_id: worktreeId },
      query: {
        session_id: sessionId,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.includeArchived ? { include_archived: true } : {}),
      },
    },
  );
}

export async function getChat(
  conversationId: string,
): Promise<ChatConversationDetail> {
  return requestJson("GET", "/api/chats/{conversation_id}", {
    path: { conversation_id: conversationId },
  });
}

export async function getChatActivity(
  conversationId: string,
  itemId: string,
): Promise<ChatActivityDetail> {
  return requestJson("GET", "/api/chats/{conversation_id}/activity/{item_id}", {
    path: { conversation_id: conversationId, item_id: itemId },
  });
}

export async function listChatModels(): Promise<ChatModelOption[]> {
  return requestJson("GET", "/api/chats/models", {});
}

export async function patchChatSettings(
  conversationId: string,
  patch: ChatConversationSettingsPatch,
): Promise<ChatConversationSummary> {
  return requestJson("PATCH", "/api/chats/{conversation_id}/settings", {
    path: { conversation_id: conversationId },
    body: patch,
  });
}

export async function sendChatMessage(
  conversationId: string,
  text: string,
  worktreeId?: string,
): Promise<void> {
  await requestVoid("POST", "/api/chats/{conversation_id}/messages", {
    path: { conversation_id: conversationId },
    body: {
      text,
      ...(worktreeId ? { worktree_id: worktreeId } : {}),
    },
  });
}

export function codexAgUiChatUrl(conversationId: string): string {
  return `${BASE}/chats/${encodeURIComponent(conversationId)}/ag-ui`;
}

export async function archiveChat(
  conversationId: string,
): Promise<ChatConversationSummary> {
  return requestJson("POST", "/api/chats/{conversation_id}/archive", {
    path: { conversation_id: conversationId },
  });
}

export async function unarchiveChat(
  conversationId: string,
): Promise<ChatConversationSummary> {
  return requestJson("POST", "/api/chats/{conversation_id}/unarchive", {
    path: { conversation_id: conversationId },
  });
}

export async function deleteChat(conversationId: string): Promise<void> {
  try {
    await requestVoid("DELETE", "/api/chats/{conversation_id}", {
      path: { conversation_id: conversationId },
    });
  } catch (error) {
    if (!(error instanceof ApiStatusError && error.status === 404)) throw error;
  }
}

export async function interruptChat(conversationId: string): Promise<void> {
  await requestVoid("POST", "/api/chats/{conversation_id}/interrupt", {
    path: { conversation_id: conversationId },
  });
}

export async function resolveChatPendingRequest(
  conversationId: string,
  requestId: string,
  request: ResolveChatPendingRequestRequest,
): Promise<ChatPendingRequest> {
  return requestJson(
    "POST",
    "/api/chats/{conversation_id}/requests/{request_id}/resolve",
    {
      path: { conversation_id: conversationId, request_id: requestId },
      body: request,
    },
  );
}
