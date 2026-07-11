import { Archive, MessageSquarePlus, RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { executeCommand } from "@/lib/commands";
import { useChatStore } from "@/lib/stores/chats";
import { useSettingsStore } from "@/lib/stores/settings";
import { selectAllTabs, useTabStore } from "@/lib/stores/tabs";
import type {
  ChatConversationSummary,
  ChatRuntimeLifecycle,
  Worktree,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
};

function formatRelativeTime(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) {
    return "just now";
  }
  if (deltaSeconds < 3600) {
    return `${Math.floor(deltaSeconds / 60)}m ago`;
  }
  if (deltaSeconds < 86_400) {
    return `${Math.floor(deltaSeconds / 3600)}h ago`;
  }
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

function runtimeLabel(
  lifecycle: ChatRuntimeLifecycle | undefined,
): string | null {
  switch (lifecycle) {
    case "starting":
      return "Starting";
    case "ready":
      return "Warm";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Error";
    default:
      return null;
  }
}

export default function WorktreeChatsPanel({ worktree }: Props) {
  const [scope, setScope] = useState<"branch" | "project">("branch");
  const [showArchived, setShowArchived] = useState(false);
  const chatEnabled = useSettingsStore(
    (state) => state.settings.experimental.chatEnabled,
  );
  const activeTabId = useTabStore((state) => state.activeTabId);
  const tabs = useTabStore(selectAllTabs);
  const conversationsById = useChatStore((state) => state.conversationsById);
  const archiveConversation = useChatStore(
    (state) => state.archiveConversation,
  );
  const unarchiveConversation = useChatStore(
    (state) => state.unarchiveConversation,
  );
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const conversations = useMemo(
    () =>
      Object.values(conversationsById)
        .filter(
          (conversation) =>
            conversation.sessionId === "default" &&
            conversation.projectId === worktree.project_id &&
            (scope === "project" ||
              conversation.branchName === worktree.branch ||
              (!conversation.branchName &&
                conversation.worktreeId === worktree.id)),
        )
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt),
    [
      conversationsById,
      scope,
      worktree.branch,
      worktree.id,
      worktree.project_id,
    ],
  );
  const activeConversations = conversations.filter(
    (conversation) => conversation.archivedAt == null,
  );
  const archivedConversations = conversations.filter(
    (conversation) => conversation.archivedAt != null,
  );
  const runtimesByConversationId = useChatStore(
    (state) => state.runtimesByConversationId,
  );

  if (!chatEnabled) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Chat is disabled in Experimental settings.
      </div>
    );
  }

  function isConversationActive(
    conversation: ChatConversationSummary,
  ): boolean {
    return tabs.some(
      (tab) =>
        tab.id === activeTabId &&
        tab.type === "agent_chat" &&
        tab.conversation_id === conversation.id,
    );
  }

  function canOpenConversation(conversation: ChatConversationSummary): boolean {
    if (conversation.branchName) {
      return conversation.branchName === worktree.branch;
    }
    return conversation.worktreeId === worktree.id;
  }

  async function handleDelete(conversation: ChatConversationSummary) {
    if (
      !window.confirm(
        `Permanently delete "${conversation.title}" and all chat history?`,
      )
    ) {
      return;
    }
    await deleteConversation(conversation.id);
  }

  function renderConversation(conversation: ChatConversationSummary) {
    const runtime = runtimesByConversationId[conversation.id];
    const label = runtimeLabel(runtime?.lifecycle);
    const active = isConversationActive(conversation);
    const canOpen = canOpenConversation(conversation);

    return (
      <SidebarMenuItem key={conversation.id}>
        <div
          className={cn(
            "group rounded-lg border transition-colors",
            active
              ? "border-sidebar-primary bg-sidebar-primary/10"
              : "border-transparent hover:border-border hover:bg-muted/40",
            !canOpen && "opacity-70",
          )}
        >
          <button
            type="button"
            className="w-full px-3 py-2 text-left"
            disabled={!canOpen}
            title={
              canOpen
                ? `Open ${conversation.title}`
                : "Open this chat from a worktree on the same branch."
            }
            onClick={() => {
              if (!canOpen) {
                return;
              }
              void executeCommand({
                args: {
                  conversationId: conversation.id,
                  worktreeId: worktree.id,
                },
                id: "tab.openChat",
                source: "button",
              });
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {conversation.title}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>{formatRelativeTime(conversation.lastActivityAt)}</span>
                  {scope === "project" ? (
                    <span className="truncate">
                      · {conversation.branchName ?? "legacy worktree"}
                    </span>
                  ) : null}
                </div>
              </div>
              {label ? (
                <Badge variant="secondary" className="shrink-0">
                  {label}
                </Badge>
              ) : null}
            </div>
            {conversation.lastError ? (
              <div className="mt-2 line-clamp-2 text-xs text-destructive">
                {conversation.lastError}
              </div>
            ) : null}
          </button>
          <div className="flex items-center justify-end gap-1 px-2 pb-2">
            {conversation.archivedAt == null ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Archive chat"
                title="Archive chat"
                onClick={() => void archiveConversation(conversation.id)}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Unarchive chat"
                title="Unarchive chat"
                onClick={() => void unarchiveConversation(conversation.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              aria-label="Delete chat permanently"
              title="Delete chat permanently"
              onClick={() => void handleDelete(conversation)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </SidebarMenuItem>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-3 py-3">
        <Button
          className="w-full justify-start gap-2"
          onClick={() => {
            void executeCommand({
              args: { worktreeId: worktree.id },
              id: "tab.newChat",
              source: "button",
            });
          }}
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Chat
        </Button>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant={scope === "branch" ? "secondary" : "ghost"}
            className="flex-1"
            onClick={() => setScope("branch")}
          >
            Current branch
          </Button>
          <Button
            size="sm"
            variant={scope === "project" ? "secondary" : "ghost"}
            className="flex-1"
            onClick={() => setScope("project")}
          >
            Project
          </Button>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 w-full justify-start"
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {activeConversations.length === 0 && !showArchived ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {scope === "branch"
              ? "No chats yet for this branch."
              : "No project chats yet."}
          </div>
        ) : (
          <SidebarMenu className="gap-1 p-2">
            {activeConversations.map(renderConversation)}
            {showArchived && archivedConversations.length > 0 ? (
              <div className="px-2 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Archived
              </div>
            ) : null}
            {showArchived && archivedConversations.map(renderConversation)}
            {activeConversations.length === 0 &&
            showArchived &&
            archivedConversations.length === 0 ? (
              <div className="px-2 py-4 text-sm text-muted-foreground">
                No chats in this scope.
              </div>
            ) : null}
          </SidebarMenu>
        )}
      </ScrollArea>
    </div>
  );
}
