import { MessageSquarePlus } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar";
import { executeCommand } from "@/lib/commands";
import { useChatStore } from "@/lib/stores/chats";
import { useTabStore } from "@/lib/stores/tabs";
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
  const deltaSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp * 1000) / 1000),
  );
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
  const activeTabId = useTabStore((state) => state.activeTabId);
  const tabs = useTabStore((state) => state.tabs);
  const conversationsById = useChatStore((state) => state.conversationsById);
  const conversations = useMemo(
    () =>
      Object.values(conversationsById)
        .filter(
          (conversation) =>
            conversation.projectId === worktree.project_id &&
            conversation.worktreeId === worktree.id,
        )
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt),
    [conversationsById, worktree.id, worktree.project_id],
  );
  const runtimesByConversationId = useChatStore(
    (state) => state.runtimesByConversationId,
  );

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
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {conversations.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No chats yet for this worktree.
          </div>
        ) : (
          <SidebarMenu className="gap-1 p-2">
            {conversations.map((conversation) => {
              const runtime = runtimesByConversationId[conversation.id];
              const label = runtimeLabel(runtime?.lifecycle);
              const active = isConversationActive(conversation);

              return (
                <SidebarMenuItem key={conversation.id}>
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-sidebar-primary bg-sidebar-primary/10"
                        : "border-transparent hover:border-border hover:bg-muted/40",
                    )}
                    onClick={() => {
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
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatRelativeTime(conversation.lastActivityAt)}
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
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </ScrollArea>
    </div>
  );
}
